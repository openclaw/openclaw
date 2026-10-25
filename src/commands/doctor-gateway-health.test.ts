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
import * as restartHealth from "../cli/daemon-cli/restart-health.constants.js";
import type { OpenClawConfig } from "../config/config.js";
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

import { checkGatewayHealth, probeGatewayMemoryStatus } from "./doctor-gateway-health.js";

describe("checkGatewayHealth", () => {
  const cfg: OpenClawConfig = {};
  const sharedRuntime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const check = (config: OpenClawConfig = cfg) =>
    checkGatewayHealth({ runtime: sharedRuntime, cfg: config });
  const noteContains = (message: string, title: string) =>
    expect(note).toHaveBeenCalledWith(expect.stringContaining(message), title);
  const expectUnauthenticated = async () => {
    await expect(check()).resolves.toEqual({ authenticated: false, healthOk: true });
    expect(sharedRuntime.error).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    vi.spyOn(restartHealth, "DEFAULT_RESTART_HEALTH_TIMEOUT_MS", "get").mockReturnValue(3_000);
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
    await expect(check()).resolves.toEqual({
      healthOk: true,
      authenticated: false,
    });
    expect(sharedRuntime.log).toHaveBeenCalledWith(
      "Gateway is still starting (phase: startup-sidecars).",
    );
    expect(sharedRuntime.error).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("reports live paths when status RPC rejects", async () => {
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
          throw new Error("status unavailable");
        }
        return {};
      },
    );

    await expect(check()).resolves.toMatchObject({ authenticated: false, healthOk: false });

    noteContains("CLI and live Gateway use different", "Gateway state directory mismatch");
    noteContains(
      "the running Gateway still uses the paths it started with. A full restart is required: `openclaw gateway restart` (not a reload). Then rerun `openclaw doctor`.",
      "Gateway state directory mismatch",
    );
    expect(readServiceCommand).not.toHaveBeenCalled();
  });

  it("reports the offline service state directory", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/tmp/doctor-cli-state");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", "/tmp/doctor-cli-state/openclaw.json");
    vi.stubEnv("OPENCLAW_HOME", "/tmp/doctor-cli-home");
    callGateway.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    readServiceCommand.mockResolvedValueOnce({
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      environment: { OPENCLAW_STATE_DIR: "/tmp/doctor-service-state" },
    });

    await expect(check()).resolves.toMatchObject({
      healthOk: false,
      authenticated: false,
    });

    const warning = note.mock.calls.find(
      ([, title]) => title === "Gateway state directory mismatch",
    )?.[0];
    expect(warning).toContain("CLI and installed Gateway service use different");
    expect(warning).toContain("doctor-cli-state");
    expect(warning).toContain("doctor-service-state");
    expect(warning).toContain("openclaw gateway install --force");
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

      await expect(check()).resolves.toMatchObject({
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

      await expect(check(config)).resolves.toMatchObject({
        healthOk: false,
      });

      expect(readServiceCommand).not.toHaveBeenCalled();
    },
  );

  const execPath = "/opt/homebrew/Cellar/node@24/24.20.0/bin/node";
  it.each([
    [
      "Gateway runtime",
      { childRuntime: { execPath, available: false } },
      [execPath, "Restart the Gateway"],
    ],
    [
      "SQLite WAL",
      { sqliteWal: createSqliteWalHealth({ walBytes: null, databaseBytes: null }) },
      [
        "checkpoint blocked",
        "WAL unknown",
        "last complete never observed",
        "2 consecutive blocked observations",
        "openclaw gateway restart",
        "openclaw status --deep",
      ],
    ],
    [
      "Secret runtime degradation",
      {
        secretEgressProxy: {
          state: "degraded",
          message: "Check the system clock, then restart the Gateway.",
        },
      },
      ["Check the system clock, then restart the Gateway."],
    ],
    [
      "Model reasoning",
      { modelReasoningWarning: "Model emitted hidden reasoning; set reasoning:true." },
      ["set reasoning:true"],
    ],
  ] as const)("reports %s without failing healthy RPC", async (title, status, fragments) => {
    callGateway.mockResolvedValueOnce(status).mockResolvedValue({});
    await expect(check()).resolves.toMatchObject({ healthOk: true, authenticated: true });
    for (const fragment of fragments) {
      noteContains(fragment, title);
    }
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

    await check();

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
      statusIssues: [
        {
          channel: "feishu",
          accountId: "default",
          kind: "runtime",
          message,
          fix: "resolve the reported channel error, then restart the channel",
        },
      ],
    });

    await expect(check()).resolves.toMatchObject({
      authenticated: true,
      healthOk: true,
    });

    expect(note).toHaveBeenCalledWith(
      `- feishu default: ${message} (resolve the reported channel error, then restart the channel)`,
      "Channel warnings",
    );
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
            setTimeout(
              () => {
                if (responseMs !== null && responseMs < timeoutMs) {
                  resolve(method === "status" ? { ok: true } : { statusIssues: [] });
                } else {
                  reject(
                    method === "diagnostics.stability"
                      ? new GatewayProtocolRequestTimeoutError(
                          { method, timeoutMs, requestSent: true },
                          `gateway request timeout for ${method}`,
                        )
                      : new Error(`gateway timeout after ${timeoutMs}ms`),
                  );
                }
              },
              Math.min(responseMs ?? timeoutMs, timeoutMs),
            );
            started.resolve();
          });
        },
      );
      return {
        statusStarted: statusStarted.promise,
        diagnosticsStarted: Promise.all([channelsStarted.promise, exporterStarted.promise]),
      };
    }

    it("allows slow diagnostics after a 100 ms status response", async () => {
      const started = mockResponseTiming(100, 4_000);
      const result = check();
      await started.statusStarted;
      await vi.advanceTimersByTimeAsync(100);
      await started.diagnosticsStarted;
      await vi.advanceTimersByTimeAsync(4_000);

      await expect(result).resolves.toMatchObject({ healthOk: true, authenticated: true });
      expect(note).not.toHaveBeenCalled();
      expect(sharedRuntime.error).not.toHaveBeenCalled();
    });

    it("reports measured latency and the exhausted diagnostic budget without failing health", async () => {
      vi.spyOn(restartHealth, "DEFAULT_RESTART_HEALTH_TIMEOUT_MS", "get").mockReturnValue(10_000);
      const started = mockResponseTiming(7_000, null);
      const result = check();
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
      expect(sharedRuntime.error).not.toHaveBeenCalled();
    });
  });

  it.each([
    {
      method: "channels.status",
      title: "Channel warnings",
      text: "channel probe failed\\nAuthorization: Bearer",
      retry: "openclaw channels status --probe",
    },
    {
      method: "diagnostics.stability",
      title: "Telemetry exporters",
      text: "Exporter diagnostics failed: exporter probe failed",
      retry: "openclaw gateway stability --type telemetry.exporter",
    },
  ])(
    "sanitizes $method failures without failing health",
    async ({ method, title, text, retry }) => {
      const token = "sk-abcdefghijklmnopqrstuv";
      callGateway.mockResolvedValueOnce({ ok: true });
      if (method === "diagnostics.stability") {
        callGateway.mockResolvedValueOnce({});
      }
      callGateway.mockRejectedValueOnce(
        new Error(
          `\u001B[31m${method === "channels.status" ? "channel" : "exporter"} probe failed\nAuthorization: Bearer ${token}`,
        ),
      );
      await expect(check()).resolves.toEqual({
        authenticated: true,
        healthOk: true,
        status: { ok: true },
      });
      const [message, actualTitle] = note.mock.calls.at(-1) ?? [];
      expect(actualTitle).toBe(title);
      expect(message).toContain(text);
      expect(message).toContain(`Retry: ${retry}`);
      expect(message).not.toContain(token);
      expect(message).not.toContain("\u001B");
      expect(message.split("\n")).toHaveLength(2);
      expect(sharedRuntime.error).not.toHaveBeenCalled();
    },
  );

  it("notes CLI and gateway version mismatch when the gateway reports another runtime version", async () => {
    callGateway.mockResolvedValueOnce({ runtimeVersion: "2026.4.23" }).mockResolvedValueOnce({});
    await check();
    noteContains("the running Gateway is OpenClaw 2026.4.23", "OpenClaw version mismatch");
  });

  it.each([
    ["auth profile migration required", "doctor --fix"],
    ["secret reference was not found", "secrets reload"],
  ])("reports the Doctor remedy for %s", async (reason, command) => {
    vi.stubEnv("OPENCLAW_PROFILE", "");
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", undefined);
    callGateway
      .mockResolvedValueOnce({
        degradedSecretOwners: [
          {
            ownerKind: "route",
            ownerId: "legacy-agent",
            state: "unavailable",
            paths: ["auth-profile-legacy:auth-profiles"],
            reason,
          },
        ],
      })
      .mockResolvedValue({});
    await expect(check()).resolves.toMatchObject({ healthOk: true, authenticated: true });
    expect(note).toHaveBeenCalledWith(
      `- cold route:legacy-agent (auth-profile-legacy:auth-profiles): ${reason}\n  Retry: openclaw ${command}`,
      "Secret runtime degradation",
    );
  });

  it("lists every plugin configured unavailable by Gateway startup", async () => {
    const plugins = [
      ["discord", "unreadable-package-json", "permission denied"],
      ["matrix", "missing-main-entry", "dist/index.js is missing"],
    ];
    callGateway
      .mockResolvedValueOnce({
        degradedPlugins: plugins.map(([pluginId, reason, detail]) => ({
          pluginId,
          state: "configured-unavailable",
          diagnostic: { kind: "plugin-verification", reason, detail },
        })),
      })
      .mockResolvedValueOnce({});

    await check();

    expect(note).toHaveBeenCalledWith(
      [
        "- discord (unreadable-package-json): permission denied",
        "- matrix (missing-main-entry): dist/index.js is missing",
      ].join("\n"),
      "Plugins configured unavailable",
    );
  });

  it.each(["probe-rate-limit", "typed-rate-limit", "missing-scope", "secret-ref"] as const)(
    "keeps a reachable Gateway healthy with %s",
    async (kind) => {
      const rateLimited = kind.endsWith("rate-limit");
      const direct = kind === "typed-rate-limit";
      let error: Error;
      if (direct || kind === "missing-scope") {
        const protocolError = new GatewayClientRequestError(
          direct
            ? {
                code: "INVALID_REQUEST",
                message: "unauthorized: too many failed authentication attempts (retry later)",
                details: {
                  code: "AUTH_RATE_LIMITED",
                  authReason: "rate_limited",
                  recommendedNextStep: "wait_then_retry",
                },
                retryable: true,
                retryAfterMs: 60_000,
              }
            : {
                code: "FORBIDDEN",
                message: "missing scope: operator.read",
                details: {
                  code: "MISSING_SCOPE",
                  missingScope: "operator.read",
                  requiredScopes: ["operator.read"],
                },
              },
        );
        error = protocolError;
        retainGatewayResponsePayload(protocolError, undefined);
      } else {
        error = new Error("gateway.auth.password unavailable");
        (kind === "secret-ref"
          ? isGatewaySecretRefUnavailableError
          : isGatewayCredentialsRequiredError
        ).mockReturnValueOnce(true);
      }
      callGateway.mockRejectedValueOnce(error);
      if (!direct) {
        probeGatewayStatus.mockResolvedValueOnce({
          ok: false,
          kind: "connect",
          error: TEST_AUTH_CLOSE_ERROR,
          gatewayReached: true,
          ...(rateLimited
            ? { connectFailure: { kind: "rate-limited", detailCode: "AUTH_RATE_LIMITED" } }
            : {}),
        });
      }
      await expectUnauthenticated();
      expect(probeGatewayStatus).toHaveBeenCalledTimes(direct ? 0 : 1);
      if (direct) {
        expect(isGatewayCredentialsRequiredError).not.toHaveBeenCalled();
      }
      if (kind === "secret-ref") {
        expect(isGatewaySecretRefUnavailableError).toHaveBeenCalledWith(error);
      }
      expect(note).toHaveBeenCalledWith(
        rateLimited
          ? GATEWAY_HEALTH_RATE_LIMITED_MESSAGE
          : GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE,
        rateLimited ? GATEWAY_HEALTH_RATE_LIMITED_TITLE : GATEWAY_HEALTH_CREDENTIALS_REQUIRED_TITLE,
      );
      if (rateLimited) {
        expect(note).not.toHaveBeenCalledWith(
          GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE,
          GATEWAY_HEALTH_CREDENTIALS_REQUIRED_TITLE,
        );
        const output = note.mock.calls.flat().join("\n");
        expect(output).not.toContain("gateway.remote.token");
        expect(output).not.toContain("devices rotate");
      }
    },
  );
});

describe("probeGatewayMemoryStatus", () => {
  const cfg: OpenClawConfig = {};
  const runtimeFacts = {
    engine: "llama.cpp",
    state: "ready",
    backend: "metal",
    buildType: "prebuilt",
  };
  const ready = { checked: true, ready: true, skipped: false, error: undefined };
  const unavailable = { checked: false, ready: false, skipped: false };

  beforeEach(() => {
    callGateway.mockReset();
  });

  it.each([
    ["cached", { embedding: { ok: true } }, ready],
    [
      "runtime facts",
      { embedding: { ok: true }, embeddingRuntime: runtimeFacts },
      { ...ready, runtimeFacts },
    ],
    [
      "shallow skip",
      { embedding: { ok: false, checked: false, error: "memory embedding readiness not checked" } },
      { ...unavailable, skipped: true, error: expect.stringContaining("not checked") },
    ],
    [
      "transport timeout",
      new Error(`gateway timeout after 8000ms\nGateway target: ${TEST_GATEWAY_URL}`),
      { ...unavailable, error: expect.stringContaining("gateway memory check timed out") },
    ],
    [
      "request timeout",
      new Error("gateway request timeout for doctor.memory.status"),
      {
        ...unavailable,
        checked: true,
        error: "gateway memory check unavailable: gateway request timeout for doctor.memory.status",
      },
    ],
  ] as const)(
    "distinguishes %s without a live embedding probe",
    async (_name, response, expected) => {
      if (response instanceof Error) {
        callGateway.mockRejectedValue(response);
      } else {
        callGateway.mockResolvedValue(response);
      }
      await expect(probeGatewayMemoryStatus({ cfg })).resolves.toEqual(expected);
      expect(callGateway).toHaveBeenCalledWith({
        method: "doctor.memory.status",
        params: { probe: false },
        timeoutMs: 8_000,
        sharedStateMode: "read-only",
        config: cfg,
      });
    },
  );
});
