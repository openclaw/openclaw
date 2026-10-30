import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../cli/daemon-cli/diagnostic-readiness.js", () => ({
  waitForGatewayDiagnosticReadiness: vi.fn(async () => undefined),
}));
import { GatewayClientRequestError } from "../../packages/gateway-client/src/index.js";
import { retainGatewayResponsePayload } from "../../packages/gateway-client/src/protocol-request.js";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { waitForGatewayDiagnosticReadiness } from "../cli/daemon-cli/diagnostic-readiness.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { ExitError } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  buildRateLimitedHealthDiagnostic,
  GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE,
  GATEWAY_HEALTH_RATE_LIMITED_MESSAGE,
  GATEWAY_HEALTH_REACHABLE_LINE,
} from "./gateway-health-auth-diagnostic.js";
import { formatContextEngineHealthLine, formatHealthCheckFailure } from "./health-format.js";
import type { HealthSummary } from "./health.js";
import { healthCommand, healthCommandNonExiting } from "./health.js";
import {
  healthSummary as createHealthSummary,
  multiAccountHealth,
  pluginHealthError,
  unavailablePlugin,
} from "./health.test-fixtures.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const runtime = createTestRuntime();
const textOutput = () => stripAnsi(runtime.log.mock.calls.map(([line]) => String(line)).join("\n"));
const runHealth = (options: Parameters<typeof healthCommand>[0] = {}) =>
  healthCommand({ json: false, timeoutMs: 5000, config: {}, ...options }, runtime);
async function renderHealth(
  snapshot: HealthSummary,
  options: Parameters<typeof healthCommand>[0] = {},
) {
  rpc.callGateway.mockResolvedValueOnce(snapshot);
  await runHealth(options);
  return textOutput();
}

const channelFixture = (elapsedMs: number, authAgeMs: number) => ({
  channels: {
    whatsapp: { accountId: "default", linked: true, authAgeMs },
    telegram: { accountId: "default", configured: true, probe: { ok: true, elapsedMs } },
    discord: { accountId: "default", configured: false },
  },
  channelOrder: ["whatsapp", "telegram", "discord"],
  channelLabels: { whatsapp: "WhatsApp", telegram: "Telegram", discord: "Discord" },
});

const {
  listReadOnlyChannelPluginsForConfigMock,
  isGatewaySecretRefUnavailableErrorMock,
  probeGatewayStatusMock,
} = vi.hoisted(() => ({
  listReadOnlyChannelPluginsForConfigMock: vi.fn(
    (_config: unknown, _options?: unknown): unknown[] => [],
  ),
  isGatewaySecretRefUnavailableErrorMock: vi.fn<(_value: unknown) => boolean>(),
  probeGatewayStatusMock: vi.fn(),
}));
const rpc = vi.hoisted(() => ({
  callGateway: vi.fn(),
  isGatewayCredentialsRequiredError: vi.fn<(_value: unknown) => boolean>(),
  buildGatewayConnectionDetails: vi.fn<(...args: unknown[]) => { message: string; url: string }>(),
  buildGatewayProbeConnectionDetails:
    vi.fn<(...args: unknown[]) => { message: string; url: string }>(),
  formatGatewayAuthErrorJson: vi.fn(),
  formatGatewayClientRequestErrorJson: vi.fn(),
  formatGatewayTransportErrorJson: vi.fn(),
}));
const TEST_GATEWAY_URL = "ws://127.0.0.1:18789";
const TEST_GATEWAY_MESSAGE = `Gateway mode: local\nGateway target: ${TEST_GATEWAY_URL}`;
// mock-isolation: Health scenarios use deterministic RPC responses, not the operator Gateway.
vi.mock("../gateway/call.js", () => rpc);

// mock-isolation: Exercise credential-error reporting without resolving operator credentials.
vi.mock("../gateway/credentials.js", () => ({
  isGatewaySecretRefUnavailableError: isGatewaySecretRefUnavailableErrorMock,
}));

// mock-isolation: Daemon probe outcomes are fixtures; never probe the host service.
vi.mock("../cli/daemon-cli/probe.js", () => ({
  probeGatewayStatus: probeGatewayStatusMock,
}));

// mock-isolation: Use the scenario's plugin list rather than the host plugin registry.
vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: listReadOnlyChannelPluginsForConfigMock,
}));

const requireFirstRuntimeLog = () => String(runtime.log.mock.calls[0]?.[0]);

describe("healthCommand", () => {
  beforeEach(() => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.clearAllMocks();
    for (const details of [
      rpc.buildGatewayConnectionDetails,
      rpc.buildGatewayProbeConnectionDetails,
    ]) {
      details.mockReturnValue({ message: TEST_GATEWAY_MESSAGE, url: TEST_GATEWAY_URL });
    }
    for (const formatterMock of [
      rpc.formatGatewayAuthErrorJson,
      rpc.formatGatewayClientRequestErrorJson,
      rpc.formatGatewayTransportErrorJson,
    ]) {
      formatterMock.mockReset().mockReturnValue(null);
    }
    rpc.isGatewayCredentialsRequiredError.mockReturnValue(false);
    isGatewaySecretRefUnavailableErrorMock.mockReturnValue(false);
    probeGatewayStatusMock.mockReset();
  });

  it("preserves plugin health in JSON while surfacing configured failures and unavailable warnings", async () => {
    const agentSessions = {
      path: "/tmp/sessions.json",
      count: 1,
      recent: [{ key: "+1555", updatedAt: Date.now(), age: 0 }],
    };
    const snapshot = createHealthSummary({
      ...channelFixture(1, 5000),
      sessions: agentSessions,
    });
    snapshot.plugins = {
      loaded: ["calendar"],
      errors: [
        pluginHealthError("calendar", "service scheduler: address already in use", {
          activated: true,
          failurePhase: "service",
        }),
        pluginHealthError("inactive", "inactive plugin load failed"),
        pluginHealthError("explicit-owner", "runtime entry missing", {
          origin: "config",
          activationSource: "explicit",
          failurePhase: "load",
        }),
      ],
      unavailable: [unavailablePlugin("memory-owner")],
    };
    const original = structuredClone(snapshot);
    rpc.callGateway.mockResolvedValueOnce(snapshot);

    await runHealth({ json: true });

    expect(rpc.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "health", sharedStateMode: "read-only" }),
    );
    expect(runtime.exit).not.toHaveBeenCalled();
    const parsed = JSON.parse(requireFirstRuntimeLog()) as HealthSummary;
    expect(parsed).toMatchObject({
      durationMs: 5,
      channels: { whatsapp: { linked: true }, telegram: { configured: true } },
      sessions: { count: 1 },
    });
    expect(parsed.plugins).toEqual(original.plugins);

    runtime.log.mockClear();
    const output = await renderHealth(snapshot);
    expect(output).toContain("Gateway check duration: 5ms");
    expect(output).toContain(`Session store (main): ${parsed.sessions.path}`);
    expect(output).toContain(
      "Plugin calendar: failed - service scheduler: address already in use; run openclaw doctor",
    );
    expect(output).not.toContain("inactive plugin load failed");
    expect(snapshot).toEqual(original);
    expect(output).toContain("Plugin explicit-owner: failed - runtime entry missing");
    expect(output).toContain(
      "Plugin memory-owner: unavailable - unreadable-package-json: manifest unreadable",
    );
  });

  it("preserves configured duration precision in heartbeat", async () => {
    const everyMs = 691_265_001;
    const snapshot = createHealthSummary();
    const agent = snapshot.agents[0]!;
    agent.heartbeat = { ...agent.heartbeat, every: `${everyMs}ms`, everyMs };
    snapshot.heartbeatSeconds = Math.round(everyMs / 1_000);
    expect(await renderHealth(snapshot, { timeoutMs: 1000 })).toContain(
      "Heartbeat interval: 1w 1d 1m 5s 1ms (main)",
    );
  });

  it.each([
    { configured: undefined, available: false },
    { configured: true, available: true },
  ])(
    "keeps local diagnostic metadata separate from identity logging (configured=$configured, available=$available)",
    async ({ configured, available }) => {
      const account = {
        accountId: "default",
        enabled: true,
        configured: true,
        token: "resolved-token",
      };
      const resolveAccount = vi.fn(() => account);
      const logSelfId = vi.fn();
      listReadOnlyChannelPluginsForConfigMock.mockReturnValueOnce([
        {
          id: "diagnostic-fixture",
          meta: { label: "Diagnostic" },
          config: {
            listAccountIds: () => ["default"],
            inspectAccount: () => ({
              accountId: "default",
              enabled: true,
              configured,
              tokenSource: "secretref",
              tokenStatus: available ? "available" : "configured_unavailable",
            }),
            resolveAccount,
          },
          status: { logSelfId },
        },
      ]);
      rpc.callGateway.mockResolvedValueOnce(
        createHealthSummary({
          channels: { "diagnostic-fixture": { accountId: "default", configured, linked: true } },
          channelOrder: ["diagnostic-fixture"],
          channelLabels: { "diagnostic-fixture": "Diagnostic" },
        }),
      );

      await healthCommand({ config: { diagnostics: { flags: ["health"] } } }, runtime);

      expect(textOutput()).toContain(`configured=${configured ?? "unknown"} tokenSource=secretref`);
      if (available) {
        expect(logSelfId).toHaveBeenCalledWith(expect.objectContaining({ account }));
      } else {
        expect(logSelfId).not.toHaveBeenCalled();
        expect(resolveAccount).not.toHaveBeenCalled();
      }
    },
  );

  it("surfaces unhealthy secondary accounts without an explicit account binding", async () => {
    const snapshot = multiAccountHealth({ healthState: "blocked" });
    listReadOnlyChannelPluginsForConfigMock.mockReturnValueOnce([
      { id: "matrix", config: { listAccountIds: () => ["main", "alerts"] } },
    ]);

    const output = await renderHealth(snapshot, { timeoutMs: 1000 });
    expect(output).toContain("Matrix: blocked");
    expect(output).not.toContain("Matrix: ok");
  });

  it("shows each explicit fleet owner's sessions with missing agent summaries", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const storePath = state.statePath("shared.sqlite");
      const updatedAt = Date.now();
      const entries = [
        ["alpha", "first"],
        ["alpha", "second"],
        ["beta", "only"],
      ] as const;
      for (const [agentId, key] of entries) {
        await replaceSessionEntry(
          { agentId, storePath, sessionKey: `agent:${agentId}:${key}` },
          { sessionId: `${agentId}-${key}`, updatedAt },
        );
      }
      const { agents: _agents, ...snapshot } = createHealthSummary();
      rpc.callGateway.mockResolvedValueOnce({ ...snapshot, defaultAgentId: undefined });

      await runHealth({
        json: false,
        timeoutMs: 1_000,
        config: {
          session: { store: storePath },
          agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
        },
      });

      const output = textOutput();
      expect(output).toContain(
        `Session store (alpha): ${storePath} (2 entries)\n- agent:alpha:first`,
      );
      expect(output).toContain(`Session store (beta): ${storePath} (1 entries)\n- agent:beta:only`);
      expect(output).not.toContain("(default)");
    });
  });

  it("prints persistent event-loop degradation duration in text output", async () => {
    const snapshot = createHealthSummary({
      eventLoop: {
        degraded: true,
        degradedSinceMs: 180_000,
        reasons: ["event_loop_delay" as const],
        intervalMs: 30_000,
        delayP99Ms: 1_200,
        delayMaxMs: 1_500,
        utilization: 0.75,
        cpuCoreRatio: 0.5,
      },
    });
    const output = await renderHealth(snapshot, { timeoutMs: 1000 });
    expect(output).toContain("Gateway event loop: degraded for 3m");
    expect(output).toContain("p99=1200ms");
  });

  it("prints the config hot-reload disabled line in text output", async () => {
    const snapshot = createHealthSummary({ configReload: { hotReloadStatus: "disabled" } });
    const output = await renderHealth(snapshot);
    expect(output).toContain(
      "Config hot reload: disabled (watcher retries exhausted; restart the gateway to restore it)",
    );
  });

  it("prints top-level gateway ages with client clock skew", async () => {
    const gatewayNow = Date.now();
    const recent = [
      { key: "main", updatedAt: gatewayNow - 60_000, age: 60_000 },
      { key: "fresh", updatedAt: gatewayNow, age: 0 },
      { key: "foo", updatedAt: null, age: null },
    ];
    const snapshot = createHealthSummary({
      ...channelFixture(7, 5 * 60_000),
      sessions: {
        path: "/tmp/sessions.json",
        count: recent.length,
        recent,
      },
    });
    snapshot.agents = [];
    rpc.callGateway.mockResolvedValueOnce(snapshot);
    vi.spyOn(Date, "now").mockReturnValue(gatewayNow + 600_000);
    await runHealth({
      json: false,
      verbose: true,
      timeoutMs: 1000,
      config: { agents: { ownership: "explicit", entries: {} } },
    });

    expect(runtime.exit).not.toHaveBeenCalled();
    const output = textOutput();
    expect(output).toContain("- main (1m ago)\n- fresh (0m ago)\n- foo (no activity)");
    expect(output).toMatch(/WhatsApp: linked/i);
    expect(runtime.log.mock.calls.slice(0, 3)).toEqual([
      ["Gateway connection:"],
      ["  Gateway mode: local"],
      [`  Gateway target: ${TEST_GATEWAY_URL}`],
    ]);
    expect(rpc.buildGatewayConnectionDetails).toHaveBeenCalled();
  });

  it.each(["request", "credentials"] as const)(
    "keeps %s failures machine-readable in JSON mode",
    async (kind) => {
      const request = {
        code: "UNAVAILABLE",
        message: "health snapshot unavailable",
        details: { operation: "refresh" },
        retryable: true,
        retryAfterMs: 250,
      };
      const credentialMessage = "gateway health requires credentials";
      const error =
        kind === "request" ? new GatewayClientRequestError(request) : new Error(credentialMessage);
      const payload = {
        ok: false,
        error:
          kind === "request"
            ? { type: "gateway_request_error", ...request }
            : { type: "gateway_credentials_required", message: credentialMessage },
      };
      rpc.callGateway.mockRejectedValueOnce(error);
      if (kind === "credentials") {
        rpc.isGatewayCredentialsRequiredError.mockReturnValue(true);
        probeGatewayStatusMock.mockResolvedValueOnce({
          ok: false,
          kind: "connect",
          error: "connect ECONNREFUSED 127.0.0.1:18789",
        });
        rpc.formatGatewayAuthErrorJson.mockReturnValueOnce(payload);
      } else {
        rpc.formatGatewayClientRequestErrorJson.mockReturnValueOnce(payload);
      }
      await runHealth({ json: true });
      expect(rpc.formatGatewayAuthErrorJson).toHaveBeenCalledWith(error);
      if (kind === "request") {
        expect(rpc.formatGatewayClientRequestErrorJson).toHaveBeenCalledWith(error);
        expect(runtime.log).toHaveBeenCalledTimes(1);
        expect(runtime.error).not.toHaveBeenCalled();
      }
      expect(rpc.formatGatewayTransportErrorJson).not.toHaveBeenCalled();
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(JSON.parse(requireFirstRuntimeLog())).toEqual(payload);
    },
  );

  it.each([false, true])(
    "trusts a typed authentication lockout only with a remote response (remote=%s)",
    async (remote) => {
      const error = new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "unauthorized: too many failed authentication attempts (retry later)",
        details: remote
          ? {
              code: "AUTH_RATE_LIMITED",
              authReason: "rate_limited",
              recommendedNextStep: "wait_then_retry",
            }
          : { code: "AUTH_RATE_LIMITED" },
        ...(remote ? { retryable: true, retryAfterMs: 60_000 } : {}),
      });
      if (remote) {
        retainGatewayResponsePayload(error, undefined);
      }
      rpc.callGateway.mockRejectedValueOnce(error);
      if (remote) {
        await healthCommand({ timeoutMs: 5000, config: {} }, runtime);
        expect(rpc.isGatewayCredentialsRequiredError).not.toHaveBeenCalled();
        expect(runtime.exit).toHaveBeenCalledWith(1);
        expect(runtime.log).toHaveBeenCalledTimes(2);
        expect(runtime.log.mock.calls).toEqual([
          [GATEWAY_HEALTH_REACHABLE_LINE],
          [GATEWAY_HEALTH_RATE_LIMITED_MESSAGE],
        ]);
      } else {
        await expect(healthCommand({ config: {} }, runtime)).rejects.toBe(error);
        expect(runtime.log).not.toHaveBeenCalled();
      }
      expect(probeGatewayStatusMock).not.toHaveBeenCalled();
    },
  );

  it("reports temporary authentication lockouts without credential-change guidance", async () => {
    rpc.callGateway.mockRejectedValueOnce(new Error());
    rpc.isGatewayCredentialsRequiredError.mockReturnValueOnce(true);
    probeGatewayStatusMock.mockResolvedValueOnce({
      ok: false,
      kind: "connect",
      error: "connect failed",
      connectFailure: { kind: "rate-limited", detailCode: "AUTH_RATE_LIMITED" },
      gatewayReached: true,
    });

    await healthCommand({ json: true, timeoutMs: 5000, config: {} }, runtime);

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(requireFirstRuntimeLog())).toEqual(buildRateLimitedHealthDiagnostic());
    const output = runtime.log.mock.calls.flat().join("\n");
    expect(output).not.toContain("gateway.remote.token");
    expect(output).not.toContain("devices rotate");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([4000, 5000])(
    "charges target/auth preparation and readiness to one budget (%s ms)",
    async (elapsedMs) => {
      vi.mocked(waitForGatewayDiagnosticReadiness).mockImplementationOnce(async () => {
        vi.spyOn(performance, "now").mockReturnValue(elapsedMs);
        return {
          healthy: true,
          waitOutcome: "healthy",
          elapsedMs: 1000,
          runtime: { status: "running", pid: 42 },
          portUsage: { port: 18789, status: "busy", listeners: [{ pid: 42 }], hints: [] },
          staleGatewayPids: [],
        };
      });
      if (elapsedMs === 5000) {
        await expect(healthCommand({ timeoutMs: 5000, config: {} }, runtime)).rejects.toThrow(
          "Gateway diagnostic budget exhausted",
        );
        expect(rpc.callGateway).not.toHaveBeenCalled();
      } else {
        rpc.callGateway.mockResolvedValueOnce(createHealthSummary());
        await healthCommand({ timeoutMs: 5000, config: {} }, runtime);
        expect(rpc.callGateway).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 1000 }));
      }
    },
  );

  it("keeps readiness exhaustion machine-readable without a second network probe", async () => {
    vi.mocked(waitForGatewayDiagnosticReadiness).mockResolvedValueOnce({
      healthy: false,
      waitOutcome: "timeout",
      elapsedMs: 5000,
      probeError: "connect ECONNREFUSED",
      runtime: { status: "stopped" },
      portUsage: { port: 18789, status: "free", listeners: [], hints: [] },
      staleGatewayPids: [],
    });
    const { formatGatewayTransportErrorJson } =
      await vi.importActual<typeof import("../gateway/call.js")>("../gateway/call.js");
    rpc.formatGatewayTransportErrorJson.mockImplementation(formatGatewayTransportErrorJson);

    await healthCommand({ json: true, timeoutMs: 5000, config: {} }, runtime);

    expect(JSON.parse(requireFirstRuntimeLog())).toMatchObject({
      ok: false,
      error: { type: "gateway_transport_error", kind: "timeout", timeoutMs: 5000 },
      gateway: { url: TEST_GATEWAY_URL },
    });
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(rpc.callGateway).not.toHaveBeenCalled();
  });

  it("keeps structured JSON failures inside the non-exiting host", async () => {
    rpc.callGateway.mockRejectedValueOnce(new Error("health request failed"));
    const payload = { ok: false, error: { type: "gateway_request_error" } };
    rpc.formatGatewayClientRequestErrorJson.mockReturnValueOnce(payload);
    await expect(
      healthCommandNonExiting({ json: true, config: {} }, runtime),
    ).rejects.toBeInstanceOf(ExitError);
    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(requireFirstRuntimeLog())).toEqual(payload);
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("throws ExitError from healthCommandNonExiting instead of exiting the host runtime", async () => {
    const error = new Error("gateway.auth.password is unavailable");
    rpc.callGateway.mockRejectedValueOnce(error);
    isGatewaySecretRefUnavailableErrorMock.mockReturnValueOnce(true);
    probeGatewayStatusMock.mockResolvedValueOnce({
      ok: false,
      kind: "connect",
      error: "gateway closed (1008):",
      gatewayReached: true,
    });

    await expect(
      healthCommandNonExiting(
        { json: false, timeoutMs: 5000, config: {}, ignoreEnvUrlOverride: true },
        runtime,
      ),
    ).rejects.toBeInstanceOf(ExitError);

    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.log.mock.calls).toEqual([
      [GATEWAY_HEALTH_REACHABLE_LINE],
      [GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE],
    ]);
  });
});

it("formatContextEngineHealthLine summarizes quarantined context engines", () => {
  const summary = createHealthSummary();
  summary.contextEngines = {
    quarantined: [
      {
        engineId: "lossless-claw",
        owner: "plugin:lossless-claw",
        operation: "assemble",
        reason: "db corrupt",
        failedAt: 123,
      },
    ],
  };

  expect(formatContextEngineHealthLine(summary)).toBe(
    "Context engine: warning (1 quarantined; downgraded to legacy: lossless-claw)",
  );
});

describe("formatHealthCheckFailure", () => {
  it("keeps non-rich output stable", () => {
    const err = new Error("gateway closed (1006 abnormal closure): no close reason");
    expect(formatHealthCheckFailure(err, { rich: false })).toBe(
      `Health check failed: ${String(err)}`,
    );
  });

  it("formats gateway connection details as indented key/value lines", () => {
    const err = new Error(`gateway closed (1006 abnormal closure (no close frame)): no close reason
Gateway target: ws://127.0.0.1:19001
Source: local loopback
Config: /Users/steipete/.openclaw-dev/openclaw.json
Bind: loopback`);
    expect(stripAnsi(formatHealthCheckFailure(err, { rich: true })))
      .toBe(`Health check failed: gateway closed (1006 abnormal closure (no close frame)): no close reason
  Gateway target: ws://127.0.0.1:19001
  Source: local loopback
  Config: /Users/steipete/.openclaw-dev/openclaw.json
  Bind: loopback`);
  });
});
