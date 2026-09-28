// Doctor gateway health tests cover gateway probe failures, auth requirements, and repair messages.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../cli/daemon-cli/diagnostic-readiness.js", () => ({
  waitForGatewayDiagnosticReadiness: vi.fn(async () => undefined),
}));
import { GatewayClientRequestError } from "../../packages/gateway-client/src/index.js";
import {
  GatewayProtocolRequestTimeoutError,
  retainGatewayResponsePayload,
} from "../../packages/gateway-client/src/protocol-request.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { waitForGatewayDiagnosticReadiness } from "../cli/daemon-cli/diagnostic-readiness.js";
import type { OpenClawConfig } from "../config/config.js";
import { GatewayTransportError } from "../gateway/transport-error.js";
import { collectChannelStatusIssues } from "../infra/channels-status-issues.js";
import {
  GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE,
  GATEWAY_HEALTH_CREDENTIALS_REQUIRED_TITLE,
  GATEWAY_HEALTH_RATE_LIMITED_MESSAGE,
  GATEWAY_HEALTH_RATE_LIMITED_TITLE,
} from "./gateway-health-auth-diagnostic.js";
import { createSqliteWalHealth } from "./sqlite-wal-health.test-support.js";

const callGateway = vi.hoisted(() => vi.fn());
const isGatewayCredentialsRequiredError = vi.hoisted(() => vi.fn(() => false));
const isGatewaySecretRefUnavailableError = vi.hoisted(() => vi.fn(() => false));
const probeGatewayStatus = vi.hoisted(() => vi.fn());
const readServiceCommand = vi.hoisted(() => vi.fn());
const buildGatewayConnectionDetails = vi.hoisted(() => vi.fn());
const note = vi.hoisted(() => vi.fn());
const TEST_GATEWAY_URL = "ws://127.0.0.1:18789";
const TEST_AUTH_CLOSE_ERROR = "gateway closed (1008):";
const TEST_TLS_FINGERPRINT = "sha256:test-doctor-gateway-fingerprint";

vi.mock("../gateway/call.js", () => ({
  buildGatewayConnectionDetails,
  buildGatewayProbeConnectionDetails: vi.fn(() => ({
    preauthHandshakeTimeoutMs: 4321,
    tlsFingerprint: TEST_TLS_FINGERPRINT,
    url: TEST_GATEWAY_URL,
  })),
  callGateway,
  isGatewayCredentialsRequiredError,
}));

vi.mock("../gateway/credentials.js", () => ({
  isGatewaySecretRefUnavailableError,
}));

vi.mock("../cli/daemon-cli/probe.js", () => ({
  probeGatewayStatus,
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({ readCommand: readServiceCommand }),
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note,
}));

vi.mock("./health.js", () => ({
  healthCommand: vi.fn(),
}));

import { checkGatewayHealth, probeGatewayMemoryStatus } from "./doctor-gateway-health.js";

describe("checkGatewayHealth", () => {
  const cfg: OpenClawConfig = {};
  const sharedRuntime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

  beforeEach(() => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    sharedRuntime.log.mockReset();
    sharedRuntime.error.mockReset();
    sharedRuntime.exit.mockReset();
    callGateway.mockReset();
    isGatewayCredentialsRequiredError.mockReset();
    isGatewayCredentialsRequiredError.mockReturnValue(false);
    isGatewaySecretRefUnavailableError.mockReset();
    isGatewaySecretRefUnavailableError.mockReturnValue(false);
    probeGatewayStatus.mockReset();
    readServiceCommand.mockReset().mockResolvedValue(null);
    buildGatewayConnectionDetails.mockReset().mockReturnValue({
      message: `Gateway target: ${TEST_GATEWAY_URL}`,
      url: TEST_GATEWAY_URL,
    });
    note.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps a starting Gateway non-failing without running diagnostics or prompting recovery", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    vi.mocked(waitForGatewayDiagnosticReadiness).mockImplementationOnce(async (opts) => {
      opts.onProgress?.("startup-sidecars");
      return {
        healthy: false,
        waitOutcome: "still-starting",
        startupPhase: "startup-sidecars",
        elapsedMs: 60_000,
        runtime: { status: "running", pid: 42 },
        portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
        staleGatewayPids: [],
      };
    });
    await expect(checkGatewayHealth({ runtime, cfg })).resolves.toEqual({
      healthOk: true,
      authenticated: false,
    });
    expect(runtime.log).toHaveBeenCalledWith(
      "Gateway is still starting (phase: startup-sidecars).",
    );
    expect(runtime.error).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "reports live paths when status RPC rejection is %s",
    async (rejectStatus) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", "/tmp/doctor-cli-state");
      vi.stubEnv("OPENCLAW_CONFIG_PATH", "/tmp/doctor-cli-state/openclaw.json");
      callGateway.mockImplementation(
        async (options: {
          method?: string;
          onHelloOk?: (hello: { snapshot: { stateDir: string; configPath: string } }) => void;
        }) => {
          if (options.method === "status") {
            options.onHelloOk?.({
              snapshot: {
                stateDir: "/tmp/doctor-gateway-state",
                configPath: "/tmp/doctor-gateway-state/openclaw.json",
              },
            });
            if (rejectStatus) {
              throw new Error("status unavailable");
            }
          }
          return {};
        },
      );

      await expect(
        checkGatewayHealth({ runtime: sharedRuntime, cfg: {} as OpenClawConfig }),
      ).resolves.toMatchObject({ authenticated: !rejectStatus, healthOk: !rejectStatus });

      expect(note).toHaveBeenCalledWith(
        expect.stringContaining("CLI and live Gateway use different"),
        "Gateway state directory mismatch",
      );
      expect(readServiceCommand).not.toHaveBeenCalled();
    },
  );

  it("uses a lightweight status RPC for the restart liveness gate", async () => {
    callGateway.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({});

    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      await expect(
        checkGatewayHealth({ runtime: sharedRuntime, cfg, timeoutMs: 3000 }),
      ).resolves.toEqual({
        authenticated: true,
        healthOk: true,
        status: { ok: true },
      });
    } finally {
      now.mockRestore();
    }

    expect(callGateway).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "status",
        params: { includeChannelSummary: false },
        timeoutMs: 3000,
        config: cfg,
      }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(2, {
      method: "channels.status",
      params: { probe: true, timeoutMs: 5000 },
      timeoutMs: 6000,
      config: cfg,
    });
    expect(callGateway).toHaveBeenNthCalledWith(3, {
      method: "diagnostics.stability",
      params: { type: "telemetry.exporter", limit: 1000 },
      timeoutMs: 6000,
      config: cfg,
    });
    expect(sharedRuntime.error).not.toHaveBeenCalled();
    expect(note.mock.calls.map(([, title]) => title)).not.toContain("OpenClaw version mismatch");
  });

  it.each([
    { OPENCLAW_STATE_DIR: "/tmp/doctor-service-state" },
    { HOME: "/tmp/doctor-service-home" },
  ])("reports the offline service state directory from %j", async (environment) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/tmp/doctor-cli-state");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", "/tmp/doctor-cli-state/openclaw.json");
    vi.stubEnv("OPENCLAW_HOME", "/tmp/doctor-cli-home");
    callGateway.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    readServiceCommand.mockResolvedValueOnce({
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      environment,
    });

    await expect(checkGatewayHealth({ runtime: sharedRuntime, cfg })).resolves.toMatchObject({
      healthOk: false,
      authenticated: false,
    });

    const warning = note.mock.calls.find(
      ([, title]) => title === "Gateway state directory mismatch",
    )?.[0];
    expect(warning).toContain("CLI and installed Gateway service use different");
    expect(warning).toContain("doctor-cli-state");
    expect(warning).toContain(
      environment.OPENCLAW_STATE_DIR ? "doctor-service-state" : "doctor-service-home",
    );
    expect(warning).toContain("openclaw gateway install --force");
    expect(readServiceCommand).toHaveBeenCalledWith(
      expect.not.objectContaining({ OPENCLAW_STATE_DIR: expect.anything() }),
      expect.objectContaining({ requireEffective: true }),
    );
  });

  it.each(["connection details", "service environment"] as const)(
    "reports unavailable offline %s without replacing the health failure or exposing errors",
    async (source) => {
      callGateway.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const inspectionError = new Error("secret-service-environment-canary");
      if (source === "connection details") {
        buildGatewayConnectionDetails.mockImplementationOnce(() => {
          throw inspectionError;
        });
      } else {
        readServiceCommand.mockRejectedValueOnce(inspectionError);
      }

      await expect(checkGatewayHealth({ runtime: sharedRuntime, cfg })).resolves.toMatchObject({
        healthOk: false,
      });

      expect(note).toHaveBeenCalledWith(
        expect.stringContaining("could not be verified"),
        "Gateway state directory",
      );
      const output = JSON.stringify(note.mock.calls);
      expect(output).not.toContain("secret-service-environment-canary");
      expect(output).not.toContain("Gateway state directory mismatch");
      expect(sharedRuntime.error).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
    },
  );

  it.each([
    { name: "remote URL override", config: {}, url: "wss://gateway.example" },
    {
      name: "remote loopback tunnel",
      config: { gateway: { mode: "remote", remote: { url: TEST_GATEWAY_URL } } },
      url: TEST_GATEWAY_URL,
    },
  ] satisfies Array<{ name: string; config: OpenClawConfig; url: string }>)(
    "does not use a local service to diagnose $name",
    async ({ config, url }) => {
      buildGatewayConnectionDetails.mockReturnValue({ url });
      callGateway.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      await expect(
        checkGatewayHealth({ runtime: sharedRuntime, cfg: config }),
      ).resolves.toMatchObject({
        healthOk: false,
      });

      expect(readServiceCommand).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["startupMigrationWarning", "Startup migration warnings"],
    ["startupRecoveryWarning", "Startup session recovery"],
    ["installationReplacementWarning", "Installation replaced"],
  ])("reports %s without marking the gateway unhealthy", async (field, title) => {
    const warning = 'Inspect the affected state. Run "openclaw doctor".';
    callGateway.mockResolvedValueOnce({ [field]: warning }).mockResolvedValue({});
    await expect(checkGatewayHealth({ runtime: sharedRuntime, cfg })).resolves.toMatchObject({
      healthOk: true,
    });
    expect(note).toHaveBeenCalledWith(warning, title);
  });

  it.each([true, false])("reports the Gateway's recorded SQLite warning=%s", async (warning) => {
    const sqliteWal = createSqliteWalHealth({
      observedAtMs: Date.parse("2026-09-13T12:00:00.000Z"),
      walBytes: null,
      databaseBytes: null,
      consecutiveBlocked: warning ? 2 : 1,
      warning,
    });
    callGateway.mockResolvedValueOnce({ sqliteWal }).mockResolvedValue({});
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await expect(checkGatewayHealth({ runtime, cfg })).resolves.toMatchObject({ healthOk: true });

    const message = note.mock.calls.find(([, title]) => title === "SQLite WAL")?.[0];
    if (!warning) {
      expect(message).toBeUndefined();
      return;
    }
    expect(message).toContain("checkpoint blocked");
    expect(message).toContain("WAL unknown");
    expect(message).toContain("last complete never observed");
    expect(message).toContain("2 consecutive blocked observations");
    expect(message).toContain("openclaw gateway restart");
    expect(message).toContain("openclaw status --deep");
  });

  it("renders the shared redacted telemetry exporter summary", async () => {
    callGateway
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        events: [
          {
            seq: 1,
            type: "telemetry.exporter",
            source: "diagnostics-otel",
            target: "logs",
            transport: "stdout",
            outcome: "started",
            reason: "configured",
            payload: "private log payload",
          },
        ],
      });

    await checkGatewayHealth({ runtime: sharedRuntime, cfg, timeoutMs: 3000 });

    expect(note).toHaveBeenCalledWith(
      "diagnostics-otel · logs · started · stdout",
      "Telemetry exporters",
    );
    expect(JSON.stringify(note.mock.calls)).not.toContain("private log payload");
  });

  it("reports the recorded plugin trust refusal without retry advice that hides its remedy", async () => {
    const message =
      'Plugin "feishu" loaded from "/fixture/plugins-local/feishu/index.js"; installSource="path". Install the official npm package or ClawHub listing.';
    callGateway.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({
      statusIssues: collectChannelStatusIssues(
        {
          channelAccounts: {
            feishu: [
              {
                accountId: "default",
                running: false,
                lifecycle: "blocked",
                terminalDisconnect: true,
                ingressUnavailable: true,
                lastError: message,
              },
            ],
          },
        },
        [{ id: "feishu" }],
      ),
    });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await expect(
      checkGatewayHealth({ runtime: runtime as never, cfg, timeoutMs: 3000 }),
    ).resolves.toMatchObject({ authenticated: true, healthOk: true });

    expect(note).toHaveBeenCalledWith(
      `- feishu default: ${message} (resolve the reported channel error, then restart the channel)`,
      "Channel warnings",
    );
  });

  it("reports failed channel diagnostics without marking a reachable gateway unhealthy", async () => {
    callGateway
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("channel probe timed out"));
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await expect(
      checkGatewayHealth({ runtime: runtime as never, cfg, timeoutMs: 3000 }),
    ).resolves.toEqual({ authenticated: true, healthOk: true, status: { ok: true } });

    expect(note).toHaveBeenCalledWith(
      [
        "Channel status probe failed: channel probe timed out",
        "Retry: openclaw channels status --probe",
      ].join("\n"),
      "Channel warnings",
    );
    expect(runtime.error).not.toHaveBeenCalled();
  });

  describe("latency-aware diagnostics", () => {
    beforeEach(async () => {
      await import("../agents/tools/in-process-gateway.js");
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function mockResponseTiming(statusMs: number | null, diagnosticsMs: number | null) {
      const statusStarted = createDeferred();
      const channelsStarted = createDeferred();
      const exporterStarted = createDeferred();
      callGateway.mockImplementation(
        ({ method, timeoutMs }: { method: string; timeoutMs: number }) => {
          const started =
            method === "status"
              ? statusStarted
              : method === "channels.status"
                ? channelsStarted
                : exporterStarted;
          const responseMs = method === "status" ? statusMs : diagnosticsMs;
          return new Promise((resolve, reject) => {
            let response: ReturnType<typeof setTimeout> | undefined;
            const deadline = setTimeout(() => {
              clearTimeout(response);
              reject(
                method === "diagnostics.stability"
                  ? new GatewayProtocolRequestTimeoutError(
                      { method, timeoutMs, requestSent: true },
                      `gateway request timeout for ${method}`,
                    )
                  : new Error(`gateway timeout after ${timeoutMs}ms`),
              );
            }, timeoutMs);
            if (responseMs !== null) {
              response = setTimeout(() => {
                clearTimeout(deadline);
                resolve(method === "status" ? { ok: true } : { statusIssues: [] });
              }, responseMs);
            }
            started.resolve();
          });
        },
      );
      return {
        statusStarted: statusStarted.promise,
        diagnosticsStarted: Promise.all([channelsStarted.promise, exporterStarted.promise]),
      };
    }

    it.each([
      {
        timeoutMs: 10_000,
        statusMs: 7_000,
        diagnosticsMs: 12_000,
        budgetMs: 21_000,
        probeMs: 13_000,
      },
      { timeoutMs: 3_000, statusMs: 100, diagnosticsMs: 4_000, budgetMs: 6_100, probeMs: 5_000 },
      { timeoutMs: 3_000, statusMs: 2_000, diagnosticsMs: 5_000, budgetMs: 8_000, probeMs: 5_000 },
      {
        timeoutMs: 20_000,
        statusMs: 12_000,
        diagnosticsMs: 12_000,
        budgetMs: 30_000,
        probeMs: 17_000,
      },
    ])("allows slow diagnostics after a $statusMs ms status response", async (timing) => {
      const started = mockResponseTiming(timing.statusMs, timing.diagnosticsMs);
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const result = checkGatewayHealth({ runtime, cfg, timeoutMs: timing.timeoutMs });
      await started.statusStarted;
      await vi.advanceTimersByTimeAsync(timing.statusMs);
      await started.diagnosticsStarted;
      await vi.advanceTimersByTimeAsync(timing.diagnosticsMs);

      await expect(result).resolves.toMatchObject({ healthOk: true, authenticated: true });
      expect(note).not.toHaveBeenCalled();
      expect(runtime.error).not.toHaveBeenCalled();
      expect(callGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "channels.status",
          params: { probe: true, timeoutMs: timing.probeMs },
          timeoutMs: timing.budgetMs,
        }),
      );
      expect(callGateway).toHaveBeenCalledWith(
        expect.objectContaining({ method: "diagnostics.stability", timeoutMs: timing.budgetMs }),
      );
    });

    it("reports measured latency and the exhausted diagnostic budget without failing health", async () => {
      const started = mockResponseTiming(7_000, null);
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const result = checkGatewayHealth({ runtime, cfg, timeoutMs: 10_000 });
      await started.statusStarted;
      await vi.advanceTimersByTimeAsync(7_000);
      await started.diagnosticsStarted;
      await vi.advanceTimersByTimeAsync(21_000);

      await expect(result).resolves.toMatchObject({ healthOk: true, authenticated: true });
      expect(note).toHaveBeenCalledWith(
        expect.stringContaining(
          "Gateway answered status in 7s; channel diagnostics did not finish within 21s",
        ),
        "Channel warnings",
      );
      expect(note).toHaveBeenCalledWith(
        expect.stringContaining(
          "Gateway answered status in 7s; exporter diagnostics did not finish within 21s",
        ),
        "Telemetry exporters",
      );
      expect(
        note.mock.calls.every(([message]) => String(message).includes("host may be slow")),
      ).toBe(true);
      expect(runtime.error).not.toHaveBeenCalled();
    });

    it("does not run follow-up channel probes when status never answers", async () => {
      const started = mockResponseTiming(null, null);
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const result = checkGatewayHealth({ runtime, cfg, timeoutMs: 3_000 });
      await started.statusStarted;
      await vi.advanceTimersByTimeAsync(2_999);
      expect(runtime.error).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await expect(result).resolves.toEqual({
        authenticated: false,
        healthOk: false,
        status: undefined,
      });
      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("gateway timeout after 3000ms"),
      );
    });
  });

  it("redacts credentials and terminal controls in channel probe failures", async () => {
    const token = "sk-abcdefghijklmnopqrstuv";
    callGateway
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(
        new Error(`\u001B[31mchannel probe failed\nAuthorization: Bearer ${token}`),
      );

    await expect(checkGatewayHealth({ runtime: sharedRuntime, cfg })).resolves.toEqual({
      authenticated: true,
      healthOk: true,
      status: { ok: true },
    });

    const [message, title] = note.mock.calls.at(-1) ?? [];
    expect(title).toBe("Channel warnings");
    expect(message).toContain("channel probe failed\\nAuthorization: Bearer");
    expect(message).not.toContain(token);
    expect(message).not.toContain("\u001B");
    expect(message.split("\n")).toHaveLength(2);
    expect(message).toContain("Retry: openclaw channels status --probe");
    expect(sharedRuntime.error).not.toHaveBeenCalled();
  });

  it("reports sanitized exporter diagnostic failures with a retry command", async () => {
    const token = "sk-abcdefghijklmnopqrstuv";
    callGateway
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        new Error(`\u001B[31mexporter probe failed\nAuthorization: Bearer ${token}`),
      );

    await expect(
      checkGatewayHealth({ runtime: sharedRuntime, cfg, timeoutMs: 3000 }),
    ).resolves.toEqual({
      authenticated: true,
      healthOk: true,
      status: { ok: true },
    });

    const [message, title] = note.mock.calls.at(-1) ?? [];
    expect(title).toBe("Telemetry exporters");
    expect(message).toContain("Exporter diagnostics failed: exporter probe failed");
    expect(message).toContain("Retry: openclaw gateway stability --type telemetry.exporter");
    expect(message).not.toContain(token);
    expect(message).not.toContain("\u001B");
    expect(message.split("\n")).toHaveLength(2);
    expect(sharedRuntime.error).not.toHaveBeenCalled();
  });

  it("notes CLI and gateway version mismatch when the gateway reports another runtime version", async () => {
    callGateway.mockResolvedValueOnce({ runtimeVersion: "2026.4.23" }).mockResolvedValueOnce({});

    await expect(
      checkGatewayHealth({ runtime: sharedRuntime, cfg, timeoutMs: 3000 }),
    ).resolves.toEqual({
      authenticated: true,
      healthOk: true,
      status: { runtimeVersion: "2026.4.23" },
    });

    const mismatchNotes = note.mock.calls
      .filter(([, title]) => title === "OpenClaw version mismatch")
      .map(([message]) => String(message));
    const mismatchOutput = mismatchNotes.join("\n");
    expect(mismatchOutput).toContain("the running Gateway is OpenClaw 2026.4.23");
    expect(mismatchOutput).not.toContain("That usually means");
    expect(mismatchOutput).toContain("Check `openclaw --version`, `which openclaw`");
    expect(mismatchOutput).toContain(
      "If this mismatch is unexpected, update PATH so `openclaw` points to the version you want",
    );
  });

  it("reports broken egress certificates even when Gateway RPC is healthy", async () => {
    callGateway
      .mockResolvedValueOnce({
        secretEgressProxy: {
          state: "degraded",
          caExpiresAt: "2026-09-01T00:00:00.000Z",
          failedCertificates: 0,
          message: "Check the system clock, then restart the Gateway.",
        },
      })
      .mockResolvedValue({});
    expect(await checkGatewayHealth({ runtime: sharedRuntime, cfg })).toMatchObject({
      healthOk: true,
      authenticated: true,
    });
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(
        "Secret egress proxy: Check the system clock, then restart the Gateway.",
      ),
      "Secret runtime degradation",
    );
  });

  it("lists every degraded SecretRef owner reported by Gateway status", async () => {
    callGateway
      .mockResolvedValueOnce({
        degradedSecretOwners: [
          {
            ownerKind: "account",
            ownerId: "discord:ops",
            state: "unavailable",
            paths: ["channels.discord.accounts.ops.token"],
            reason: "secret reference was not found (env:default:PRIVATE_REF_ID)",
          },
          {
            ownerKind: "capability",
            ownerId: "tts",
            state: "unavailable",
            degradationState: "stale",
            paths: ["tts.providers.elevenlabs.apiKey"],
            reason: "secret provider policy denied resolution",
          },
          {
            ownerKind: "capability",
            ownerId: "web-fetch:firecrawl",
            state: "unavailable",
            paths: ["plugins.entries.firecrawl.config.webFetch.apiKey"],
            reason: "resolved secret value was invalid",
          },
        ],
      })
      .mockResolvedValueOnce({});

    await checkGatewayHealth({ runtime: sharedRuntime, cfg, timeoutMs: 3000 });

    expect(note).toHaveBeenCalledWith(
      [
        "- cold account:discord:ops (channels.discord.accounts.ops.token): secret resolution failed",
        "  Retry: openclaw secrets reload",
        "- stale capability:tts (tts.providers.elevenlabs.apiKey): secret provider policy denied resolution",
        "  Retry: openclaw secrets reload",
        "- cold capability:web-fetch:firecrawl (plugins.entries.firecrawl.config.webFetch.apiKey): resolved secret value was invalid",
        "  Retry: openclaw secrets reload",
      ].join("\n"),
      "Secret runtime degradation",
    );
  });

  it("lists every plugin configured unavailable by Gateway startup", async () => {
    callGateway
      .mockResolvedValueOnce({
        degradedPlugins: [
          {
            pluginId: "discord",
            state: "configured-unavailable",
            diagnostic: {
              kind: "plugin-verification",
              reason: "unreadable-package-json",
              detail: "permission denied",
            },
          },
          {
            pluginId: "matrix",
            state: "configured-unavailable",
            diagnostic: {
              kind: "plugin-verification",
              reason: "missing-main-entry",
              detail: "dist/index.js is missing",
            },
          },
        ],
      })
      .mockResolvedValueOnce({});

    await checkGatewayHealth({ runtime: sharedRuntime, cfg, timeoutMs: 3000 });

    expect(note).toHaveBeenCalledWith(
      [
        "- discord (unreadable-package-json): permission denied",
        "- matrix (missing-main-entry): dist/index.js is missing",
      ].join("\n"),
      "Plugins configured unavailable",
    );
  });

  it("reports a typed close without depending on gateway error wording", async () => {
    const error = new GatewayTransportError({
      message: "transport closed: \u001B]52;c;YXR0YWNr\u0007protocol version mismatch",
      kind: "closed",
      code: 1008,
      connectionDetails: {
        url: TEST_GATEWAY_URL,
        urlSource: "local loopback",
        message: `Gateway target: ${TEST_GATEWAY_URL}`,
      },
    });
    callGateway.mockRejectedValueOnce(error);

    await checkGatewayHealth({ runtime: sharedRuntime, cfg, timeoutMs: 3000 });

    expect(note).toHaveBeenCalledWith(
      "Gateway connect failed: transport closed: protocol version mismatch",
      "Gateway",
    );
    expect(note).not.toHaveBeenCalledWith("Gateway not running.", "Gateway");
  });

  it("reports credentials-required when status RPC auth blocks a reachable gateway", async () => {
    callGateway.mockRejectedValueOnce(new Error());
    isGatewayCredentialsRequiredError.mockReturnValueOnce(true);
    probeGatewayStatus.mockResolvedValueOnce({
      ok: false,
      kind: "connect",
      error: TEST_AUTH_CLOSE_ERROR,
      gatewayReached: true,
    });

    await expect(
      checkGatewayHealth({ runtime: sharedRuntime, cfg, timeoutMs: 3000 }),
    ).resolves.toEqual({
      authenticated: false,
      healthOk: true,
    });

    expect(probeGatewayStatus).toHaveBeenCalledWith({
      url: TEST_GATEWAY_URL,
      timeoutMs: 3000,
      tlsFingerprint: TEST_TLS_FINGERPRINT,
      preauthHandshakeTimeoutMs: 4321,
      config: cfg,
      json: true,
    });
    expect(sharedRuntime.error).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE,
      GATEWAY_HEALTH_CREDENTIALS_REQUIRED_TITLE,
    );
    expect(callGateway).toHaveBeenCalledTimes(1);
  });

  it("reports a temporary lockout when status auth is rate-limited", async () => {
    callGateway.mockRejectedValueOnce(new Error());
    isGatewayCredentialsRequiredError.mockReturnValueOnce(true);
    probeGatewayStatus.mockResolvedValueOnce({
      ok: false,
      kind: "connect",
      error: "connect failed",
      connectFailure: { kind: "rate-limited", detailCode: "AUTH_RATE_LIMITED" },
      gatewayReached: true,
    });

    await expect(
      checkGatewayHealth({ runtime: sharedRuntime, cfg, timeoutMs: 3000 }),
    ).resolves.toEqual({
      authenticated: false,
      healthOk: true,
    });

    expect(sharedRuntime.error).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      GATEWAY_HEALTH_RATE_LIMITED_MESSAGE,
      GATEWAY_HEALTH_RATE_LIMITED_TITLE,
    );
    expect(note).not.toHaveBeenCalledWith(
      GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE,
      GATEWAY_HEALTH_CREDENTIALS_REQUIRED_TITLE,
    );
    const output = note.mock.calls.flat().join("\n");
    expect(output).not.toContain("gateway.remote.token");
    expect(output).not.toContain("devices rotate");
  });

  it("handles the real typed rate-limit error without forcing the credentials predicate", async () => {
    const error = new GatewayClientRequestError({
      code: "INVALID_REQUEST",
      message: "unauthorized: too many failed authentication attempts (retry later)",
      details: {
        code: "AUTH_RATE_LIMITED",
        authReason: "rate_limited",
        recommendedNextStep: "wait_then_retry",
      },
      retryable: true,
      retryAfterMs: 60_000,
    });
    retainGatewayResponsePayload(error, undefined);
    callGateway.mockRejectedValueOnce(error);

    await expect(
      checkGatewayHealth({ runtime: sharedRuntime, cfg, timeoutMs: 3000 }),
    ).resolves.toEqual({
      authenticated: false,
      healthOk: true,
    });

    expect(isGatewayCredentialsRequiredError).not.toHaveBeenCalled();
    expect(probeGatewayStatus).not.toHaveBeenCalled();
    expect(sharedRuntime.error).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      GATEWAY_HEALTH_RATE_LIMITED_MESSAGE,
      GATEWAY_HEALTH_RATE_LIMITED_TITLE,
    );
  });

  it("reports credentials-required when status RPC auth SecretRefs are unavailable", async () => {
    const error = new Error("gateway.auth.password unavailable");
    callGateway.mockRejectedValueOnce(error);
    isGatewaySecretRefUnavailableError.mockReturnValueOnce(true);
    probeGatewayStatus.mockResolvedValueOnce({
      ok: false,
      kind: "connect",
      error: TEST_AUTH_CLOSE_ERROR,
      gatewayReached: true,
    });

    await expect(
      checkGatewayHealth({ runtime: sharedRuntime, cfg, timeoutMs: 3000 }),
    ).resolves.toEqual({
      authenticated: false,
      healthOk: true,
    });

    expect(isGatewaySecretRefUnavailableError).toHaveBeenCalledWith(error);
    expect(probeGatewayStatus).toHaveBeenCalledWith({
      url: TEST_GATEWAY_URL,
      timeoutMs: 3000,
      tlsFingerprint: TEST_TLS_FINGERPRINT,
      preauthHandshakeTimeoutMs: 4321,
      config: cfg,
      json: true,
    });
    expect(sharedRuntime.error).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE,
      GATEWAY_HEALTH_CREDENTIALS_REQUIRED_TITLE,
    );
    expect(callGateway).toHaveBeenCalledTimes(1);
  });
});

describe("probeGatewayMemoryStatus", () => {
  const cfg: OpenClawConfig = {};

  beforeEach(() => {
    callGateway.mockReset();
  });

  it("requests cached memory status without a live embedding probe", async () => {
    callGateway.mockResolvedValue({ embedding: { ok: true } });

    await expect(probeGatewayMemoryStatus({ cfg, timeoutMs: 1234 })).resolves.toEqual({
      checked: true,
      ready: true,
      error: undefined,
      skipped: false,
    });

    expect(callGateway).toHaveBeenCalledWith({
      method: "doctor.memory.status",
      params: { probe: false },
      timeoutMs: 1234,
      config: cfg,
    });
  });

  it("carries last-known llama.cpp facts from the gateway", async () => {
    callGateway.mockResolvedValue({
      embedding: { ok: true },
      embeddingRuntime: {
        engine: "llama.cpp",
        state: "ready",
        backend: "metal",
        buildType: "prebuilt",
      },
    });

    await expect(probeGatewayMemoryStatus({ cfg })).resolves.toMatchObject({
      checked: true,
      ready: true,
      runtimeFacts: {
        state: "ready",
        backend: "metal",
        buildType: "prebuilt",
      },
    });
  });

  it("treats outer gateway timeouts as inconclusive (skipped: false)", async () => {
    // A transport timeout must NOT be treated as a skipped probe. It is a real
    // diagnostic signal and the renderer should warn for key-optional providers.
    callGateway.mockRejectedValue(
      new Error(`gateway timeout after 8000ms\nGateway target: ${TEST_GATEWAY_URL}`),
    );

    const result = await probeGatewayMemoryStatus({ cfg });
    expect(result.checked).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.error).toContain("gateway memory probe timed out");
    expect(result.skipped).toBe(false);
  });

  it("propagates checked: false and skipped: true when gateway skipped the embedding probe", async () => {
    // Gateway returns checked: false when called with probe: false and no cached
    // availability data (SKIPPED_MEMORY_EMBEDDING_PROBE shape). The adapter must
    // also set skipped: true so renderers can distinguish this from a transport
    // timeout (which also returns checked: false but skipped: false).
    callGateway.mockResolvedValue({
      embedding: {
        ok: false,
        checked: false,
        error:
          "memory embedding readiness not checked; run `openclaw memory status --deep` to probe",
      },
    });

    const result = await probeGatewayMemoryStatus({ cfg });
    expect(result.checked).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.error).toContain("not checked");
    expect(result.skipped).toBe(true);
  });

  it("keeps gateway request timeouts as explicit failures", async () => {
    callGateway.mockRejectedValue(new Error("gateway request timeout for doctor.memory.status"));

    await expect(probeGatewayMemoryStatus({ cfg })).resolves.toEqual({
      checked: true,
      ready: false,
      error: "gateway memory probe unavailable: gateway request timeout for doctor.memory.status",
      skipped: false,
    });
  });
});
