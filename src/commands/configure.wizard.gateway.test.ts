import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { ExitError } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import type { WizardSection } from "./configure.shared.js";
import {
  createWizardTestRuntime as createRuntime,
  queueWizardTestPrompts as queueWizardPrompts,
  runConfigureWizard,
  setupWizardTestDefaults,
  setupBaseWizardTestState as setupBaseWizardState,
  wizardTestMocks as mocks,
} from "./configure.wizard.test-support.js";

const { maybeInstallDaemon, formatHealthCheckFailure } = mocks;

const written = () => mocks.writeConfigFile.mock.calls.at(-1)![0];

function configure(sections?: WizardSection[]) {
  return runConfigureWizard({ command: "configure", sections }, createRuntime());
}

type Gateway = NonNullable<OpenClawConfig["gateway"]>;
function localGateway(auth: Gateway["auth"] = {}, extra: Partial<Gateway> = {}) {
  setupBaseWizardState({ gateway: { mode: "local", auth, ...extra } });
}
function remoteGateway(remote: Gateway["remote"]) {
  const config: OpenClawConfig = {
    gateway: { mode: "remote", remote: { url: "wss://gateway.example.test", ...remote } },
    secrets: { providers: { default: { source: "env" } } },
  };
  setupBaseWizardState(config);
  queueWizardPrompts({ select: ["remote"], confirm: [] });
  mocks.promptRemoteGatewayConfig.mockResolvedValueOnce(config);
  return config;
}
const secretRef = (id: string) => ({ source: "env" as const, provider: "default", id });
const noted = (title: string) =>
  mocks.note.mock.calls.findLast(([, heading]) => heading === title)?.[0];
function recordSectionWrites(port: number) {
  const events: string[] = [];
  mocks.promptAuthConfig.mockImplementation(async (cfg: OpenClawConfig) => {
    events.push("model");
    return cfg;
  });
  mocks.promptGatewayConfig.mockImplementation(async (cfg: OpenClawConfig) => {
    events.push("gateway");
    return { config: cfg, port };
  });
  mocks.setupChannels.mockImplementation(async (cfg: OpenClawConfig) => {
    events.push("channels");
    return cfg;
  });
  mocks.writeConfigFile.mockImplementation(async () => {
    events.push("commit");
  });
  return events;
}

describe("runConfigureWizard", () => {
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
    queueWizardPrompts({ select: ["local", "configure"], confirm: [] });
    const events = recordSectionWrites(18991);
    maybeInstallDaemon.mockImplementationOnce(async () => {
      events.push("daemon");
      return "succeeded";
    });
    await configure(["daemon", "channels", "gateway", "model"]);

    expect(events).toEqual(["model", "gateway", "channels", "commit", "daemon"]);
    expect(maybeInstallDaemon).toHaveBeenCalledWith(expect.objectContaining({ port: 18991 }));
    expect(mocks.clackText).not.toHaveBeenCalled();
    expect(mocks.probeGatewayReachable).toHaveBeenCalledWith(
      expect.objectContaining({ url: "ws://127.0.0.1:18991", timeoutMs: 300 }),
    );

    expect(mocks.writeConfigFile).toHaveBeenCalledOnce();
  });

  it("commits every interactive section before running the next section", async () => {
    queueWizardPrompts({
      select: ["local", "model", "gateway", "channels", "configure", "__continue"],
      confirm: [],
    });
    const events = recordSectionWrites(18789);
    await configure();

    expect(events).toEqual(["model", "commit", "gateway", "commit", "channels", "commit"]);
    expect(mocks.writeConfigFile).toHaveBeenCalledTimes(3);
  });

  it.each([
    { outcome: "succeeded", reachable: false, completion: "Daemon setup completed." },
    {
      outcome: "failed",
      reachable: false,
      completion: "Configuration unchanged, but daemon setup failed.",
    },
    { outcome: "skipped", reachable: false, completion: "Daemon setup skipped." },
  ] as const)(
    "reports startup reachability after daemon $outcome ($reachable)",
    async ({ outcome, reachable, completion }) => {
      setupBaseWizardState({ gateway: { mode: "local" } });
      queueWizardPrompts({ select: ["local"], confirm: [] });
      maybeInstallDaemon.mockResolvedValueOnce(outcome);
      mocks.waitForGatewayReachable.mockResolvedValueOnce({ ok: reachable });

      await configure(["daemon"]);

      expect(mocks.note).toHaveBeenCalledWith(
        expect.stringContaining(reachable ? "Gateway: reachable" : "Gateway: not detected"),
        "Control UI",
      );
      expect(mocks.clackOutro).toHaveBeenCalledWith(completion);
      if (outcome !== "succeeded") {
        expect(mocks.waitForGatewayReachable).not.toHaveBeenCalled();
      }
    },
  );

  it("observes fresh startup after an interactive health check followed by daemon setup", async () => {
    setupBaseWizardState({ gateway: { mode: "local" } });
    queueWizardPrompts({ select: ["local", "health", "daemon", "__continue"], confirm: [] });
    maybeInstallDaemon.mockResolvedValueOnce("succeeded");
    mocks.waitForGatewayReachable
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });

    await withMockedPlatform("linux", () => configure());

    expect(noted("Control UI")).toContain("Gateway: reachable");
    expect(mocks.waitForGatewayReachable).toHaveBeenCalledTimes(2);
    expect(mocks.waitForGatewayReachable).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ deadlineMs: 15_000 }),
    );
    expect(mocks.waitForGatewayReachable).toHaveBeenLastCalledWith(
      expect.objectContaining({ deadlineMs: 45_000, probeTimeoutMs: 10_000 }),
    );
  });

  it("keeps remote password health when the configured token ref is unresolved", async () => {
    const remotePassword = "remote-password"; // pragma: allowlist secret
    const remoteConfig = remoteGateway({
      token: secretRef("MISSING_REMOTE_TOKEN"),
      password: remotePassword,
      tlsFingerprint: "ab".repeat(32),
    });

    await configure(["health"]);

    expect(mocks.waitForGatewayReachable).toHaveBeenCalledWith(
      expect.objectContaining({
        url: remoteConfig.gateway?.remote?.url,
        config: remoteConfig,
        originScopedDeviceAuth: true,
      }),
    );
    expect(mocks.healthCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        config: remoteConfig,
        token: undefined,
        password: remotePassword,
        ignoreEnvUrlOverride: true,
      }),
      expect.anything(),
    );
  });

  it.each([
    ["unreachable gateway", false, new Error("health request failed")],
    ["trapped health CLI exit", true, new ExitError(1)],
  ])("reports failed remote health checks (%s)", async (_reason, probeOk, error) => {
    queueWizardPrompts({ select: ["remote"], confirm: [] });
    mocks.waitForGatewayReachable.mockResolvedValueOnce({ ok: probeOk });
    mocks.healthCommand.mockRejectedValueOnce(error);

    await configure(["health"]);

    expect(mocks.clackOutro).toHaveBeenCalledWith(expect.stringContaining("health check failed"));
    if (error instanceof ExitError) {
      // healthCommand already printed its diagnostic before the trapped exit.
      expect(formatHealthCheckFailure).not.toHaveBeenCalled();
    }
  });

  it("skips remote health when a configured SecretRef is unresolved", async () => {
    remoteGateway({ token: secretRef("MISSING_REMOTE_TOKEN") });
    await withEnvAsync({ OPENCLAW_GATEWAY_PASSWORD: "ambient-password" }, async () => {
      await configure(["health"]);
    });

    const authNote = mocks.note.mock.calls.find(([, title]) => title === "Gateway auth")?.[0];
    expect(authNote).toContain("Health check skipped");
    expect(mocks.healthCommand).not.toHaveBeenCalled();
    expect(mocks.clackOutro).toHaveBeenCalledWith(
      "Remote gateway configured; health check skipped.",
    );
  });

  it("persists gateway.mode=local when only the run mode is selected", async () => {
    queueWizardPrompts({
      select: ["local", "__continue"],
      confirm: [false],
    });

    await configure();

    expect(written().gateway?.mode).toBe("local");
    const writeOptions = mocks.replaceConfigFile.mock.calls[0]?.[0].writeOptions;
    expect(Object.keys(writeOptions ?? {}).toSorted()).toEqual([
      "assertConfigPathForWrite",
      "expectedConfigPath",
      "ownedConfigPathForWrite",
    ]);
  });

  it("probes and persists remote edge auth without ambient credential fallback", async () => {
    const config = remoteGateway({
      edgeAuth: { "X-Edge-Auth": "test-secret" },
      tlsFingerprint: "ab".repeat(32),
      token: "token",
    });
    await withEnvAsync({ OPENCLAW_GATEWAY_PASSWORD: "env-password" }, () => configure(["gateway"]));
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

    const probeRequests = mocks.probeGatewayReachable.mock.calls.map(([request]) => request);
    const localProbe = probeRequests.find((request) => request.url === "ws://127.0.0.1:18789");
    expect(localProbe?.token).toBe("configured-token");
    expect(localProbe?.password).toBe("configured-password");
  });

  it("uses resolved SecretRef auth for local gateway and health probes", async () => {
    localGateway({ mode: "token", token: secretRef("WIZARD_GATEWAY_TOKEN") });
    queueWizardPrompts({ select: ["local"], confirm: [] });
    maybeInstallDaemon.mockResolvedValueOnce("succeeded");

    await withEnvAsync(
      { OPENCLAW_GATEWAY_TOKEN: "ambient-token", WIZARD_GATEWAY_TOKEN: "configured-token" },
      () => withMockedPlatform("win32", () => configure(["gateway", "daemon", "health"])),
    );

    expect(mocks.probeGatewayReachable).toHaveBeenCalledWith(
      expect.objectContaining({ token: "configured-token", timeoutMs: 300 }),
    );
    expect(mocks.waitForGatewayReachable).toHaveBeenCalledWith(
      expect.objectContaining({ token: "configured-token" }),
    );
    expect(mocks.waitForGatewayReachable).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: "ws://127.0.0.1:18789",
        token: "configured-token",
        password: undefined,
        deadlineMs: 90_000,
        probeTimeoutMs: 15_000,
      }),
    );
    expect(mocks.healthCommand).toHaveBeenCalledWith(
      expect.objectContaining({ token: "configured-token" }),
      expect.anything(),
    );
  });

  it("visibly skips local probes when a configured SecretRef is unavailable", async () => {
    localGateway({ mode: "password", password: secretRef("MISSING_WIZARD_PASSWORD") });
    queueWizardPrompts({ select: ["local"], confirm: [] });

    await withEnvAsync({ OPENCLAW_GATEWAY_PASSWORD: "ambient-password" }, () =>
      configure(["gateway", "health"]),
    );

    expect(mocks.probeGatewayReachable).not.toHaveBeenCalled();
    expect(mocks.waitForGatewayReachable).not.toHaveBeenCalled();
    expect(mocks.healthCommand).not.toHaveBeenCalled();

    expect(noted("Control UI")).toContain("Gateway: auth unavailable (probe skipped)");
  });

  it("never retries an old password after the newly configured SecretRef fails", async () => {
    localGateway({ mode: "password", password: "previous-password" });
    queueWizardPrompts({ select: ["local"], confirm: [] });
    mocks.promptGatewayConfig.mockImplementationOnce(async (cfg: OpenClawConfig) => ({
      config: {
        ...cfg,
        gateway: {
          ...cfg.gateway,
          auth: {
            mode: "password",
            password: secretRef("MISSING_WIZARD_PASSWORD"),
          },
        },
      },
      port: 18789,
    }));

    await withEnvAsync({ OPENCLAW_GATEWAY_PASSWORD: "ambient-password" }, () =>
      configure(["gateway"]),
    );

    expect(mocks.probeGatewayReachable).toHaveBeenCalledOnce();
    expect(noted("Control UI")).toContain("Gateway: auth unavailable (probe skipped)");
  });

  it("advertises LAN Control UI links while probing the local gateway", async () => {
    localGateway({ token: "token" }, { bind: "lan" });
    mocks.resolveAdvertisedControlUiLinks.mockResolvedValueOnce({
      httpUrl: "http://10.211.55.3:18789/",
      wsUrl: "ws://10.211.55.3:18789",
    });
    await configure(["gateway"]);

    expect(mocks.inspectWindowsGatewayFirewall).not.toHaveBeenCalled();
    expect(noted("Control UI")).toContain(
      "Windows firewall: if another device cannot connect to the LAN URL",
    );
    expect(mocks.resolveAdvertisedControlUiLinks).toHaveBeenCalledWith(
      expect.objectContaining({ bind: "lan", port: 18789 }),
    );
    expect(mocks.probeGatewayReachable).toHaveBeenCalledWith(
      expect.objectContaining({ url: "ws://127.0.0.1:18789" }),
    );
    expect(mocks.waitForGatewayReachable).not.toHaveBeenCalled();
    expect(noted("Control UI")).toContain("Web UI: http://10.211.55.3:18789/");
    expect(noted("Control UI")).toContain("Gateway WS: ws://10.211.55.3:18789");
  });

  it.each(["wizard", "direct"])("exits with code 1 on %s cancellation", async (kind) => {
    const runtime = createRuntime();
    if (kind === "wizard") {
      mocks.clackSelect.mockRejectedValueOnce(new WizardCancelledError());
    } else {
      mocks.guardCancel.mockImplementationOnce((_value, _runtime, exitCode) => {
        expect(exitCode).toBe(1);
        throw new WizardCancelledError();
      });
    }
    await runConfigureWizard({ command: "configure" }, runtime);
    expect(runtime.exit).toHaveBeenCalledWith(1);
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
      const events: string[] = [];
      mocks.writeConfigFile.mockImplementationOnce(async () => {
        events.push("commit");
      });
      if (section === "health") {
        mocks.waitForGatewayReachable.mockImplementationOnce(async () => {
          events.push("health");
          return { ok: false };
        });
      } else {
        maybeInstallDaemon.mockImplementationOnce(async () => {
          events.push("daemon");
          return "failed";
        });
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
});
