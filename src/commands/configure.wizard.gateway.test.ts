import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import type { WizardSection } from "./configure.shared.js";
import {
  queueWizardTestPrompts as queueWizardPrompts,
  runConfigureWizard,
  setupWizardTestDefaults,
  setupBaseWizardTestState as setupBaseWizardState,
  wizardTestMocks as mocks,
} from "./configure.wizard.test-support.js";
import { resolveGatewayStartupTiming } from "./gateway-startup-timing.js";

const { maybeInstallDaemon } = mocks;

const written = () => mocks.writeConfigFile.mock.calls.at(-1)![0];

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

beforeEach(() => {
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", undefined);
  vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", undefined);
  vi.resetAllMocks();
  setupWizardTestDefaults();
  setupBaseWizardState();
});
afterEach(() => vi.unstubAllEnvs());

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
