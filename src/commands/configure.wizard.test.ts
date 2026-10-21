import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { formatCliCommand } from "../cli/command-format.js";
import { ConfigMutationConflictError } from "../config/mutate.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { committedConfigFiles } from "./committed-config.test-support.js";
import type { WizardSection } from "./configure.shared.js";
import {
  EMPTY_CONFIG_SNAPSHOT,
  queueWizardTestPrompts as queueWizardPrompts,
  runConfigureWizard,
  setupWizardTestDefaults,
  setupBaseWizardTestState as setupBaseWizardState,
  wizardTestMocks as mocks,
} from "./configure.wizard.test-support.js";
import { resolveGatewayStartupTiming } from "./gateway-startup-timing.js";

const { configureCommandFromSectionsArg } = await import("./configure.commands.js");

const written = () => mocks.writeConfigFile.mock.calls.at(-1)![0];
const configureWeb = () => runConfigureWizard({ sections: ["web"] });
const nativeSearchConfig: OpenClawConfig = {
  auth: { profiles: { "openai:default": { provider: "openai", mode: "oauth" } } },
};
const copilotConfig = (config: Record<string, string>): OpenClawConfig => ({
  plugins: { entries: { "github-copilot": { enabled: false, config } } },
});

function agentConfig(config: OpenClawConfig) {
  setupBaseWizardState(config);
  mocks.readConfigFileSnapshot.mockResolvedValue({
    ...EMPTY_CONFIG_SNAPSHOT,
    exists: true,
    config,
    sourceConfig: config,
  });
  queueWizardPrompts({ select: ["configure"], confirm: [], text: "/tmp/new-workspace" });
}

function expectWorkspaceSetup(workspaceDir: string, agentId: string) {
  expect(mocks.setupPluginConfig).toHaveBeenCalledWith(expect.objectContaining({ workspaceDir }));
  expect(mocks.setupSkills).toHaveBeenCalledWith(
    expect.any(Object),
    workspaceDir,
    expect.any(Object),
    expect.any(Object),
  );
  expect(mocks.ensureWorkspaceAndSessions).toHaveBeenCalledWith(
    workspaceDir,
    expect.any(Object),
    expect.objectContaining({ agentId }),
  );
}

beforeEach(() => {
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", undefined);
  vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", undefined);
  vi.resetAllMocks();
  setupWizardTestDefaults();
  setupBaseWizardState();
});
afterEach(() => vi.unstubAllEnvs());

it("directs invalid config to Doctor before making changes", async () => {
  mocks.readConfigFileSnapshot.mockResolvedValueOnce({
    ...EMPTY_CONFIG_SNAPSHOT,
    exists: true,
    valid: false,
    issues: [{ path: "browser.actionTimeoutTypoMs", message: "Unknown key" }],
  });
  const runtime = mocks.runtime;
  await runConfigureWizard({});
  expect(mocks.clackOutro).toHaveBeenCalledWith(
    "Config invalid. Run `openclaw doctor --fix` to apply supported repairs, then re-run configure.",
  );
  expect(runtime.exit).toHaveBeenCalledWith(1);
  expect(mocks.clackSelect).not.toHaveBeenCalled();
  expect(mocks.writeConfigFile).not.toHaveBeenCalled();
});

it("dispatches the memory section and persists its verified choice without gateway setup", async () => {
  const config: OpenClawConfig = {
    memory: { search: { cache: { enabled: false } } },
  };
  setupBaseWizardState(config);
  mocks.runMemorySetupFlow.mockImplementation(async (candidate) => ({
    ...candidate,
    memory: {
      ...candidate.memory,
      search: { ...candidate.memory?.search, provider: "openai", model: "embedding-model" },
    },
  }));
  await configureCommandFromSectionsArg(["memory"]);
  expect(mocks.runMemorySetupFlow).toHaveBeenCalledOnce();
  expect(written().memory?.search).toEqual({
    cache: { enabled: false },
    provider: "openai",
    model: "embedding-model",
  });
  expect(mocks.promptGatewayConfig).not.toHaveBeenCalled();
  expect(mocks.maybeInstallDaemon).not.toHaveBeenCalled();
});

it.each([true, false])(
  "does not write a skipped memory section (section flag: %s)",
  async (flag) => {
    setupBaseWizardState({ gateway: { mode: "local" } });
    queueWizardPrompts({ select: ["local", "memory", "__continue"], confirm: [] });
    await runConfigureWizard(flag ? { sections: ["memory"] } : {});
    expect(mocks.runMemorySetupFlow).toHaveBeenCalledOnce();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.clackOutro).toHaveBeenCalledWith("No configuration changes selected.");
  },
);

it("disables search when plugin policy leaves no available provider", async () => {
  mocks.resolveSearchProviderOptions.mockReturnValue([]);
  queueWizardPrompts({ select: [], confirm: [true, false] });
  await configureWeb();
  expect(mocks.note).toHaveBeenCalledWith(
    expect.stringContaining("No web search providers are currently available"),
    "Web search",
  );
  expect(written().tools?.web?.search?.enabled).toBe(false);
});

it("enables native search without a managed provider", async () => {
  setupBaseWizardState(nativeSearchConfig);
  queueWizardPrompts({ select: ["cached"], confirm: [true, true, false, true] });
  await configureWeb();
  expect(written().tools?.web).toMatchObject({
    search: { enabled: true, openaiCodex: { enabled: true, mode: "cached" } },
    fetch: { enabled: true },
  });
  expect(mocks.setupSearch).not.toHaveBeenCalled();
});

it("preserves the native search mode when disabling it", async () => {
  setupBaseWizardState({
    ...nativeSearchConfig,
    tools: { web: { search: { enabled: true, openaiCodex: { enabled: true, mode: "live" } } } },
  });
  queueWizardPrompts({ select: ["firecrawl"], confirm: [true, false, true, false] });
  await configureWeb();
  expect(written().tools?.web?.search).toMatchObject({
    enabled: true,
    openaiCodex: { enabled: false, mode: "live" },
  });
  expect(mocks.setupSearch).toHaveBeenCalledOnce();
});

it("preserves concurrent nested plugin writes on conflict (#64188)", async () => {
  const config = copilotConfig({ region: "us-east-1" });
  const updated = copilotConfig({ region: "us-east-1", accessToken: "plugin-wrote-this" });
  queueWizardPrompts({ select: [], confirm: [] });
  const snapshot = (source: OpenClawConfig, hash: string) => ({
    ...EMPTY_CONFIG_SNAPSHOT,
    config: source,
    sourceConfig: source,
    hash,
  });
  mocks.readConfigFileSnapshot
    .mockResolvedValueOnce(snapshot(config, "before"))
    .mockResolvedValueOnce(snapshot(config, "before"))
    .mockResolvedValueOnce(snapshot(updated, "after"));
  mocks.replaceConfigFile
    .mockImplementationOnce(async ({ baseHash }) => {
      expect(baseHash).toBe("before");
      throw new ConfigMutationConflictError("config changed since last load");
    })
    .mockImplementationOnce(async ({ nextConfig, baseHash }) => {
      expect(baseHash).toBe("after");
      await mocks.writeConfigFile(nextConfig);
      return committedConfigFiles.write(nextConfig);
    });
  await runConfigureWizard({ sections: ["workspace"] });
  expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(2);
  expect(mocks.writeConfigFile).toHaveBeenCalledOnce();
  expect(mocks.readConfigFileSnapshot).toHaveBeenCalledTimes(3);
  expect(written().agents?.defaults?.workspace).toContain("/.openclaw/workspace");
  expect(written().plugins).toEqual(updated.plugins);
});

it("does not retry after config path ownership changes", async () => {
  queueWizardPrompts({ select: [], confirm: [] });
  mocks.assertConfigPathForWrite.mockImplementation(() => {
    throw new ConfigMutationConflictError("config path changed since last load", {
      retryable: false,
    });
  });
  await expect(runConfigureWizard({ sections: ["workspace"] })).rejects.toThrow(
    "config path changed since last load",
  );
  expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
  expect(mocks.readConfigFileSnapshot).toHaveBeenCalledTimes(2);
  expect(mocks.writeConfigFile).not.toHaveBeenCalled();
});

it("uses one selected agent through setup and commits before channel hooks", async () => {
  agentConfig({
    agents: {
      ownership: "explicit",
      defaults: { workspace: "/tmp/global" },
      entries: { alpha: { workspace: "/tmp/alpha" }, beta: {} },
    },
  });
  queueWizardPrompts({ select: ["beta", "configure"], confirm: [], text: "/tmp/new-workspace" });
  const hook = vi.fn(async () => {});
  mocks.setupChannels.mockImplementationOnce(async (config, _runtime, _prompter, options) => {
    options?.onPostWriteHook?.({ channel: "matrix", accountId: "beta", run: hook });
    return config;
  });
  await runConfigureWizard({ sections: ["workspace", "plugins", "skills", "channels"] });
  expect(written().agents).toEqual({
    ownership: "explicit",
    defaults: { workspace: "/tmp/global" },
    entries: { alpha: { workspace: "/tmp/alpha" }, beta: { workspace: "/tmp/new-workspace" } },
  });
  expectWorkspaceSetup("/tmp/new-workspace", "beta");
  expect(mocks.setupChannels).toHaveBeenCalledWith(
    expect.any(Object),
    expect.any(Object),
    expect.any(Object),
    expect.objectContaining({
      workspaceDir: "/tmp/new-workspace",
      deferStatusUntilSelection: true,
      skipStatusNote: true,
    }),
  );
  expect(
    mocks.clackSelect.mock.calls.filter(
      ([params]) => params.message === "Which agent do you want to configure?",
    ),
  ).toHaveLength(1);
  expect(hook).toHaveBeenCalledOnce();
  expect(mocks.writeConfigFile.mock.invocationCallOrder[0]!).toBeLessThan(
    hook.mock.invocationCallOrder[0]!,
  );
});

it("does not persist an unprovisionable workspace", async () => {
  agentConfig({ agents: { entries: { ops: { workspace: "/tmp/ops" } } } });
  mocks.ensureWorkspaceAndSessions.mockRejectedValueOnce(new Error("workspace is unwritable"));
  await expect(
    runConfigureWizard({ sections: ["workspace", "plugins", "skills"] }),
  ).rejects.toThrow("workspace is unwritable");
  expect(mocks.setupPluginConfig).not.toHaveBeenCalled();
  expect(mocks.setupSkills).not.toHaveBeenCalled();
  expect(mocks.writeConfigFile).not.toHaveBeenCalled();
});

it("removes channel config without selecting an agent", async () => {
  const config: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
  };
  agentConfig(config);
  mocks.clackSelect.mockResolvedValueOnce("remove");
  await runConfigureWizard({ sections: ["channels"] });
  expect(mocks.setupChannels).not.toHaveBeenCalled();
  expect(mocks.clackSelect).toHaveBeenCalledOnce();
  expect(written()).toEqual(config);
});
it("rejects non-interactive configure before prompting (#93953)", async () => {
  const runtime = mocks.runtime;
  mocks.isTerminalInteractive.mockReturnValue(false);
  await configureCommandFromSectionsArg(undefined);
  expect(runtime.exit).toHaveBeenCalledWith(1);
  expect(runtime.error).toHaveBeenCalledOnce();
  const message = runtime.error.mock.calls[0]?.[0];
  expect(message).toContain("requires an interactive terminal (TTY)");
  expect(message).toContain(formatCliCommand("openclaw config set"));
  expect(message).toContain(formatCliCommand("openclaw config validate"));
  expect(mocks.clackIntro).not.toHaveBeenCalled();
  expect(mocks.writeConfigFile).not.toHaveBeenCalled();
});

it("opens the full wizard for Commander's empty section list", async () => {
  queueWizardPrompts({ select: ["local", "__continue"], confirm: [] });
  await configureCommandFromSectionsArg([]);
  expect(written().gateway?.mode).toBe("local");
  expect(mocks.writeConfigFile).toHaveBeenCalledOnce();
});

it("dispatches trimmed section names through the wizard", async () => {
  queueWizardPrompts({ select: ["configure"], confirm: [] });
  await configureCommandFromSectionsArg(["  channels  ", "\tplugins\t"]);
  expect(mocks.setupChannels).toHaveBeenCalledOnce();
  expect(mocks.setupPluginConfig).toHaveBeenCalledOnce();
  expect(mocks.promptGatewayConfig).not.toHaveBeenCalled();
  expect(mocks.writeConfigFile).toHaveBeenCalledOnce();
});

it("rejects a blank section before the terminal guard", async () => {
  mocks.isTerminalInteractive.mockReturnValue(false);
  await configureCommandFromSectionsArg(["channels", "  "]);
  expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  expect(mocks.runtime.error).toHaveBeenCalledWith(
    expect.stringContaining('Invalid --section: ""'),
  );
  expect(mocks.clackIntro).not.toHaveBeenCalled();
  expect(mocks.writeConfigFile).not.toHaveBeenCalled();
});

const { maybeInstallDaemon } = mocks;
function queue(...select: string[]) {
  queueWizardPrompts({ select, confirm: [] });
}

function configure(sections?: WizardSection[]) {
  return runConfigureWizard({ sections });
}

type Gateway = NonNullable<OpenClawConfig["gateway"]>;
function localGateway(auth: Gateway["auth"] = {}) {
  setupBaseWizardState({ gateway: { mode: "local", auth } });
}
function remoteGateway(remote: Gateway["remote"]) {
  const config: OpenClawConfig = {
    gateway: { mode: "remote", remote: { url: "wss://gateway.example.test", ...remote } },
    secrets: { providers: { default: { source: "env" } } },
  };
  setupBaseWizardState(config);
  queue("remote");
  mocks.promptRemoteGatewayConfig.mockResolvedValueOnce(config);
  return config;
}
const secretRef = (id: string) => ({ source: "env" as const, provider: "default", id });
const noted = (title: string) =>
  mocks.note.mock.calls.findLast(([, heading]) => heading === title)?.[0];
function expectRequest(mock: unknown, fields: Record<string, unknown>, ...args: unknown[]) {
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(fields), ...args);
}
function eventRecorder() {
  const events: string[] = [];
  function record<T>(event: string, result: T) {
    events.push(event);
    return result;
  }
  return { events, record };
}
function recordSectionWrites(port: number) {
  const recorder = eventRecorder();
  const { record } = recorder;
  mocks.promptAuthConfig.mockImplementation(async (cfg: OpenClawConfig) => record("model", cfg));
  mocks.promptGatewayConfig.mockImplementation(async (cfg: OpenClawConfig) =>
    record("gateway", { config: cfg, port }),
  );
  mocks.setupChannels.mockImplementation(async (cfg: OpenClawConfig) => record("channels", cfg));
  mocks.writeConfigFile.mockImplementation(async () => record("commit", undefined));
  return recorder;
}

it("commits selected sections in canonical order before installing the configured daemon", async () => {
  setupBaseWizardState({ gateway: { port: 18991 } });
  mocks.resolveGatewayPort.mockReturnValue(18991);
  mocks.probeGatewayReachable.mockResolvedValueOnce({ ok: true });
  queue("local", "configure");
  const { events, record } = recordSectionWrites(18991);
  maybeInstallDaemon.mockImplementationOnce(async () => record("daemon", "succeeded"));
  await configure(["daemon", "channels", "gateway", "model"]);

  expect(events).toEqual(["model", "gateway", "channels", "commit", "daemon"]);
  expectRequest(maybeInstallDaemon, { port: 18991 });
  expect(mocks.clackText).not.toHaveBeenCalled();
  expectRequest(mocks.probeGatewayReachable, { url: "ws://127.0.0.1:18991", timeoutMs: 300 });

  expect(mocks.writeConfigFile).toHaveBeenCalledOnce();
});

it("commits every interactive section before running the next section", async () => {
  queue("local", "model", "gateway", "channels", "configure", "__continue");
  const { events } = recordSectionWrites(18789);
  await configure();

  expect(events).toEqual(["model", "commit", "gateway", "commit", "channels", "commit"]);
  expect(mocks.writeConfigFile).toHaveBeenCalledTimes(3);
});

it.each([
  { outcome: "succeeded", completion: "Daemon setup completed." },
  { outcome: "failed", completion: "Configuration unchanged, but daemon setup failed." },
  { outcome: "skipped", completion: "Daemon setup skipped." },
] as const)(
  "reports startup reachability after daemon $outcome",
  async ({ outcome, completion }) => {
    localGateway();
    queue("local");
    maybeInstallDaemon.mockResolvedValueOnce(outcome);
    mocks.waitForGatewayReachable.mockResolvedValueOnce({ ok: false });

    await configure(["daemon"]);

    expect(noted("Control UI")).toContain("Gateway: not detected");
    expect(mocks.clackOutro).toHaveBeenCalledWith(completion);
    if (outcome !== "succeeded") {
      expect(mocks.waitForGatewayReachable).not.toHaveBeenCalled();
    }
  },
);

it("observes fresh startup after an interactive health check followed by daemon setup", async () => {
  localGateway();
  queue("local", "health", "daemon", "__continue");
  maybeInstallDaemon.mockResolvedValueOnce("succeeded");
  mocks.waitForGatewayReachable
    .mockResolvedValueOnce({ ok: true })
    .mockResolvedValueOnce({ ok: true });

  await withMockedPlatform("linux", () => configure());

  expect(noted("Control UI")).toContain("Gateway: reachable");
  expect(mocks.waitForGatewayReachable.mock.calls).toMatchObject([
    [{ deadlineMs: 15_000 }],
    [{ deadlineMs: 45_000, probeTimeoutMs: 10_000 }],
  ]);
});

it("keeps remote password health when the configured token ref is unresolved", async () => {
  const remotePassword = "remote-password"; // pragma: allowlist secret
  const remoteConfig = remoteGateway({
    token: secretRef("MISSING_REMOTE_TOKEN"),
    password: remotePassword,
    tlsFingerprint: "ab".repeat(32),
  });

  await configure(["health"]);

  expectRequest(mocks.waitForGatewayReachable, {
    url: remoteConfig.gateway?.remote?.url,
    config: remoteConfig,
    originScopedDeviceAuth: true,
  });
  expectRequest(
    mocks.healthCommand,
    {
      config: remoteConfig,
      token: undefined,
      password: remotePassword,
      ignoreEnvUrlOverride: true,
    },
    expect.anything(),
  );
});

it("reports failed remote health checks", async () => {
  queue("remote");
  mocks.waitForGatewayReachable.mockResolvedValueOnce({ ok: false });
  mocks.healthCommand.mockRejectedValueOnce(new Error("health request failed"));
  await configure(["health"]);
  expect(mocks.clackOutro).toHaveBeenCalledWith(expect.stringContaining("health check failed"));
});

it("skips remote health when a configured SecretRef is unresolved", async () => {
  remoteGateway({ token: secretRef("MISSING_REMOTE_TOKEN") });
  vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "ambient-password");
  await configure(["health"]);

  expect(noted("Gateway auth")).toContain("Health check skipped");
  expect(mocks.healthCommand).not.toHaveBeenCalled();
  expect(mocks.clackOutro).toHaveBeenCalledWith("Remote gateway configured; health check skipped.");
});

it("probes and persists remote edge auth without ambient credential fallback", async () => {
  const config = remoteGateway({
    edgeAuth: { "X-Edge-Auth": "test-secret" },
    tlsFingerprint: "ab".repeat(32),
    token: "token",
  });
  vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "env-password");
  await configure(["gateway"]);
  expect(written().gateway?.remote).toEqual(config.gateway?.remote);
  expect(mocks.probeGatewayReachable).toHaveBeenCalledWith({
    url: "wss://gateway.example.test",
    originScopedDeviceAuth: true,
    configuredRemote: true,
    config,
    token: "token",
    timeoutMs: 300,
  });
});

it("ignores blank gateway env credentials when probing the local gateway", async () => {
  localGateway({ token: "configured-token", password: "configured-password" });
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
  vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "");
  await configure(["gateway"]);

  const [localProbe] =
    mocks.probeGatewayReachable.mock.calls.find(
      ([request]) => request.url === "ws://127.0.0.1:18789",
    ) ?? [];
  expect(localProbe).toMatchObject({
    token: "configured-token",
    password: "configured-password",
  });
});

it("uses resolved SecretRef auth for local gateway and health probes", async () => {
  localGateway({ mode: "token", token: secretRef("WIZARD_GATEWAY_TOKEN") });
  queue("local");
  maybeInstallDaemon.mockResolvedValueOnce("succeeded");

  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "ambient-token");
  vi.stubEnv("WIZARD_GATEWAY_TOKEN", "configured-token");
  await withMockedPlatform("win32", () => configure(["gateway", "daemon", "health"]));

  expectRequest(mocks.probeGatewayReachable, { token: "configured-token", timeoutMs: 300 });
  expect(mocks.waitForGatewayReachable).toHaveBeenLastCalledWith(
    expect.objectContaining({
      url: "ws://127.0.0.1:18789",
      token: "configured-token",
      password: undefined,
      ...resolveGatewayStartupTiming("win32"),
    }),
  );
  expectRequest(mocks.healthCommand, { token: "configured-token" }, expect.anything());
});

it.each([false, true])(
  "skips unavailable local auth (replacing old password: %s)",
  async (replace) => {
    const auth: Gateway["auth"] = {
      mode: "password",
      password: secretRef("MISSING_WIZARD_PASSWORD"),
    };
    localGateway(replace ? { mode: "password", password: "previous-password" } : auth);
    queue("local");
    if (replace) {
      mocks.promptGatewayConfig.mockImplementationOnce(async (cfg: OpenClawConfig) => ({
        config: { ...cfg, gateway: { ...cfg.gateway, auth } },
        port: 18789,
      }));
    }
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "ambient-password");
    await configure(replace ? ["gateway"] : ["gateway", "health"]);
    expect(mocks.probeGatewayReachable).toHaveBeenCalledTimes(replace ? 1 : 0);
    expect(mocks.waitForGatewayReachable).not.toHaveBeenCalled();
    expect(mocks.healthCommand).not.toHaveBeenCalled();
    expect(noted("Control UI")).toContain("Gateway: auth unavailable (check skipped)");
  },
);

it("exits with code 1 on direct cancellation", async () => {
  mocks.guardCancel.mockImplementationOnce((_value, _runtime, exitCode) => {
    expect(exitCode).toBe(1);
    throw new WizardCancelledError();
  });
  await runConfigureWizard({});
  expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  expect(mocks.writeConfigFile).not.toHaveBeenCalled();
});

it("runs model-only configure for existing remote Gateway configs", async () => {
  setupBaseWizardState({
    gateway: { mode: "remote", remote: { url: "wss://gateway.example.test" } },
  });

  await configure(["model"]);

  expect(mocks.promptAuthConfig).toHaveBeenCalledOnce();
  expect(mocks.promptRemoteGatewayConfig).not.toHaveBeenCalled();
  expect(written().gateway?.mode).toBe("remote");
  expect(mocks.probeGatewayReachable).not.toHaveBeenCalled();
});
it.each(["health", "daemon"] as const)(
  "commits Local before interactive %s fails",
  async (section) => {
    setupBaseWizardState({ gateway: { mode: "remote" } });
    queueWizardPrompts({ select: ["local", section, "__continue"], confirm: [], text: "18789" });
    const { events, record } = eventRecorder();
    mocks.writeConfigFile.mockImplementationOnce(async () => record("commit", undefined));
    if (section === "health") {
      mocks.waitForGatewayReachable.mockImplementationOnce(async () =>
        record("health", { ok: false }),
      );
    } else {
      maybeInstallDaemon.mockImplementationOnce(async () => record("daemon", "failed"));
    }
    await configure();
    expect(mocks.writeConfigFile).toHaveBeenCalledOnce();
    expect(written().gateway?.mode).toBe("local");
    expect(events).toEqual(["commit", section]);
    expect(mocks.clackOutro).toHaveBeenLastCalledWith(
      `Configuration updated, but ${section === "health" ? "health check" : "daemon setup"} failed.`,
    );
  },
);
