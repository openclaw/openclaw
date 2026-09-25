import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  GatewayProtocolRequestError,
  retainGatewayResponsePayload,
} from "../../../packages/gateway-client/src/protocol-request.js";
import type {
  GatewaySuspendBlocker,
  GatewaySuspendPrepareResult,
} from "../../../packages/gateway-protocol/src/index.js";
import type { HelloOk } from "../../../packages/gateway-protocol/src/schema/frames.js";
import { GatewayServiceStopUnsafeError } from "../../daemon/service-inspection-error.js";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import type { CallGatewayCliOptions } from "../../gateway/call.js";
import { GATEWAY_STALE_INSTALL_CLOSE_REASON } from "../../gateway/stale-install.js";
import { createGatewayCloseTransportError } from "../../gateway/transport-error.js";
import type { PortUsage } from "../../infra/ports-types.js";
import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  managerTimeout: vi.fn(),
  legacyLock: vi.fn(),
  portUsage: vi.fn(),
}));
vi.mock("../../gateway/call.js", () => ({ callGatewayCli: mocks.call }));
vi.mock("../../infra/gateway-lock-legacy.js", () => ({
  readLegacyGatewayLockIdentity: mocks.legacyLock,
}));
vi.mock("../../infra/ports-inspect.js", () => ({ inspectPortUsage: mocks.portUsage }));
vi.mock("../../daemon/systemd-maintenance.js", () => ({
  readSystemdGatewayStopTimeout: mocks.managerTimeout,
}));
vi.mock("../../gateway/local-http-probe.js", () => ({
  createConfiguredGatewayLocalProbe: () => ({
    resolveWebSocketTarget: async () => ({ url: "ws://127.0.0.1:18789" }),
  }),
}));
vi.mock("../daemon-cli/restart-health-probe.js", () => ({
  resolveGatewayRestartProbeContext: async () => ({ config: {}, auth: {} }),
}));
vi.mock("./update-command-service-plan.js", () => ({
  resolveUpdatedGatewayRestartPort: async () => 18789,
}));

const { withGatewayMaintenanceDrain } = await import("./update-command-service-drain.js");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  mocks.call.mockReset();
  mocks.managerTimeout.mockReset().mockResolvedValue(330_000);
  mocks.legacyLock.mockReset().mockResolvedValue(undefined);
  mocks.portUsage.mockReset().mockResolvedValue({
    port: 18789,
    status: "busy",
    listeners: [{ pid: 42 }],
    hints: [],
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function ready(): GatewaySuspendPrepareResult {
  return {
    status: "ready",
    suspensionId: "resident-suspension",
    expiresAtMs: 120_000,
    activeCount: 0,
    blockers: [],
    writeCustody: [],
  };
}

function draining(
  kind: GatewaySuspendBlocker["kind"],
  message: string,
  retryAfterMs = 100,
): GatewaySuspendPrepareResult {
  return {
    status: "draining",
    suspensionId: "resident-suspension",
    expiresAtMs: 120_000,
    retryAfterMs,
    activeCount: 1,
    blockers: [{ kind, count: 1, message }],
    writeCustody:
      kind === "session-mutation" || kind === "terminal-persistence"
        ? [{ phase: kind, count: 1 }]
        : [],
  };
}

function hello(bootId: string): HelloOk {
  return {
    type: "hello-ok",
    protocol: 3,
    server: { version: "fixture", connId: "fixture-connection", bootId },
    features: { methods: [], events: [] },
    snapshot: {
      presence: [],
      health: {},
      stateVersion: { presence: 0, health: 0 },
      uptimeMs: 0,
    },
    auth: { role: "operator", scopes: ["operator.admin"] },
    policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 60_000 },
  };
}

function fixture(
  options: {
    resident?: { pid: number; shutdownBudget?: { timeoutMs: number } };
    observations?: GatewaySuspendPrepareResult[];
    bootId?: (method: string) => string;
    afterObservation?: () => void;
  } = {},
) {
  const events: string[] = [];
  const observations = options.observations ?? [ready()];
  let observationIndex = 0;
  let current = true;
  const state: GatewayServiceState = {
    installed: true,
    loadState: { status: "loaded" },
    running: true,
    env: {},
    command: null,
    runtime: { status: "running", pid: 42 },
  };
  const assertCurrent = () => {
    if (!current) {
      throw new Error("service operation authority lost");
    }
  };
  const warn = vi.fn((message: string) => events.push(`warning:${message}`));
  const stop = vi.fn(async () => {
    events.push("stop");
    return "stopped";
  });
  mocks.call.mockImplementation(async (request: CallGatewayCliOptions) => {
    // The real client swallows hello observer errors before checking dispatch authority.
    try {
      request.onHelloOk?.(hello(options.bootId?.(request.method) ?? "resident-boot"));
    } catch {}
    request.assertDispatchCurrent?.();
    if (request.method === "status") {
      events.push("status");
      return options.resident ?? { pid: 42, shutdownBudget: { timeoutMs: 25_000 } };
    }
    if (request.method === "system.info") {
      return { pid: 42 };
    }
    if (request.method === "gateway.suspend.prepare") {
      const observed = expectDefined(
        observations[Math.min(observationIndex++, observations.length - 1)],
        "Missing resident lifecycle observation fixture",
      );
      events.push(`observe:${observed.status}`);
      options.afterObservation?.();
      return observed;
    }
    if (request.method === "gateway.suspend.resume") {
      events.push("resume");
      return { ok: true, status: "running", resumed: true };
    }
    throw new Error(`Unexpected Gateway method: ${request.method}`);
  });
  return {
    events,
    warn,
    stop,
    params: { state, assertCurrent, warn, timeoutMs: 1_000 },
    loseAuthority: () => {
      current = false;
    },
  };
}

it.each([25_000, undefined])(
  "stops an idle resident with budget %s after lifecycle preparation",
  async (budget) => {
    const f = fixture({
      resident: {
        pid: 42,
        ...(budget === undefined ? {} : { shutdownBudget: { timeoutMs: budget } }),
      },
    });
    await expect(withGatewayMaintenanceDrain(f.params, f.stop)).resolves.toBe("stopped");
    expect(f.events).toEqual(["status", "observe:ready", "stop"]);
    expect(f.warn).not.toHaveBeenCalled();
  },
);

it("waits for admitted work to become idle before stopping", async () => {
  const f = fixture({ observations: [draining("embedded-run", "1 active agent turn"), ready()] });
  const running = withGatewayMaintenanceDrain(f.params, f.stop);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.events).toEqual(["status", "observe:draining"]);
  expect(f.stop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  await expect(running).resolves.toBe("stopped");
  expect(f.events).toEqual(["status", "observe:draining", "observe:ready", "stop"]);
  expect(f.warn).not.toHaveBeenCalled();
});

it("uses the existing update deadline before warning about interrupted admitted work", async () => {
  const f = fixture({
    observations: [draining("embedded-run", "1 active agent turn", DEFAULT_UPDATE_STEP_TIMEOUT_MS)],
  });
  const { timeoutMs: _timeoutMs, ...params } = f.params;
  const running = withGatewayMaintenanceDrain(params, f.stop);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.stop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(DEFAULT_UPDATE_STEP_TIMEOUT_MS);
  await expect(running).resolves.toBe("stopped");
  expect(f.warn).toHaveBeenCalledOnce();
  expect(f.warn.mock.calls[0]?.[0]).toMatch(/25000ms.*1 active agent turn.*interrupted.*330s/);
  expect(f.events.at(-1)).toBe("stop");
  expect(f.events.at(-2)).toMatch(/^warning:/);
});

it.each(["session-mutation", "terminal-persistence"] as const)(
  "refuses deadline custody in %s and releases the suspension",
  async (kind) => {
    const f = fixture({ observations: [draining(kind, `1 active ${kind} owner`)] });
    const outcome = withGatewayMaintenanceDrain(f.params, f.stop).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(GatewayServiceStopUnsafeError);
    expect(error).toMatchObject({ message: expect.stringContaining(`owner phase ${kind}`) });
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.warn).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toBe("resume");
    expect(mocks.call).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "gateway.suspend.resume",
        params: { suspensionId: "resident-suspension" },
      }),
    );
  },
);

it.each(["migration", "backup"])(
  "refuses only the reported %s phase at the deadline",
  async (phase) => {
    const observation = {
      ...draining("root-request", "1 active request"),
      writeCustody: [{ phase, count: 1 }],
    };
    const f = fixture({ observations: [observation] });
    const outcome = withGatewayMaintenanceDrain(f.params, f.stop).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(f.params.timeoutMs);
    expect(await outcome).toMatchObject({
      message: expect.stringContaining(`owner phase ${phase} (1)`),
    });
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toBe("resume");
  },
);

it("gives the final custody observation its normal RPC budget at the deadline", async () => {
  const f = fixture({
    observations: [
      { ...draining("root-request", "1 request"), writeCustody: [{ phase: "backup", count: 1 }] },
    ],
  });
  const call = expectDefined(mocks.call.getMockImplementation(), "Missing Gateway call fixture");
  mocks.call.mockImplementation(async (request: CallGatewayCliOptions) => {
    if (request.method === "gateway.suspend.prepare") {
      if ((request.timeoutMs ?? 0) < 2) {
        throw new Error("observation timed out during connection");
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 2);
      });
    }
    return await call(request);
  });
  const outcome = withGatewayMaintenanceDrain(f.params, f.stop).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(f.params.timeoutMs + 100);
  expect(await outcome).toBeInstanceOf(GatewayServiceStopUnsafeError);
  expect(f.stop).not.toHaveBeenCalled();
});

it("warns and stops when a published resident cannot distinguish root/cron custody", async () => {
  const observation: GatewaySuspendPrepareResult = {
    ...draining("root-request", "2 active gateway requests"),
    writeCustody: undefined,
    activeCount: 5,
    blockers: [
      { kind: "root-request", count: 2, message: "2 active gateway requests" },
      { kind: "cron-run", count: 3, message: "3 active cron runs" },
    ],
  };
  const f = fixture({ resident: { pid: 42 }, observations: [observation] });
  const running = withGatewayMaintenanceDrain(f.params, f.stop);
  await vi.advanceTimersByTimeAsync(f.params.timeoutMs);
  await expect(running).resolves.toBe("stopped");
  expect(f.warn).toHaveBeenCalledWith(
    expect.stringMatching(
      /WARNING:.*budget unknown.*root-request=2, cron-run=3.*cannot distinguish migrations\/backups from ordinary work.*next Gateway starts with a 330s/,
    ),
  );
  expect(f.stop).toHaveBeenCalledOnce();
});

it("stops directly when both the resident and manager have the current budget", async () => {
  const f = fixture({ resident: { pid: 42, shutdownBudget: { timeoutMs: 325_000 } } });
  await expect(withGatewayMaintenanceDrain(f.params, f.stop)).resolves.toBe("stopped");
  expect(f.events).toEqual(["status", "stop"]);
  expect(f.warn).not.toHaveBeenCalled();
});

it("does not promote an expired custody observation into a deadline refusal", async () => {
  const f = fixture({
    observations: [
      {
        ...draining("cron-run", "1 active cron run"),
        writeCustody: [{ phase: "backup", count: 1 }],
      },
    ],
  });
  const call = expectDefined(mocks.call.getMockImplementation(), "Missing Gateway call fixture");
  let observations = 0;
  mocks.call.mockImplementation(async (request: CallGatewayCliOptions) => {
    if (request.method === "gateway.suspend.prepare" && observations++ > 0) {
      throw new Error("resident unavailable");
    }
    return await call(request);
  });
  const running = withGatewayMaintenanceDrain(f.params, f.stop);
  await vi.advanceTimersByTimeAsync(f.params.timeoutMs);
  await expect(running).resolves.toBe("stopped");
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.warn).toHaveBeenCalledWith(
    expect.stringMatching(
      /cron-run=1.*Current lifecycle observation unavailable.*resident unavailable/,
    ),
  );
});

it.each([30_000, undefined])(
  "drains before stopping when the effective manager timeout is %s",
  async (timeout) => {
    const f = fixture({ resident: { pid: 42, shutdownBudget: { timeoutMs: 325_000 } } });
    mocks.managerTimeout.mockResolvedValue(timeout);
    await expect(withGatewayMaintenanceDrain(f.params, f.stop)).resolves.toBe("stopped");
    expect(f.events.filter((event) => !event.startsWith("warning:"))).toEqual([
      "status",
      "observe:ready",
      "stop",
    ]);
    expect(f.warn).toHaveBeenCalledOnce();
    expect(f.warn.mock.calls[0]?.[0]).toContain("using lifecycle drain");
  },
);

it.each([25_000, 325_000])(
  "does not retry a failed native stop with resident budget %s",
  async (timeoutMs) => {
    const f = fixture({ resident: { pid: 42, shutdownBudget: { timeoutMs } } });
    const failure = new Error("native stop failed");
    f.stop.mockRejectedValue(failure);
    await expect(withGatewayMaintenanceDrain(f.params, f.stop)).rejects.toBe(failure);
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.events.filter((event) => event === "resume")).toHaveLength(
      timeoutMs === 25_000 ? 1 : 0,
    );
  },
);

it("does not stop after authority is lost while observing the resident", async () => {
  const f = fixture({ afterObservation: () => f.loseAuthority() });
  await expect(withGatewayMaintenanceDrain(f.params, f.stop)).rejects.toThrow(
    "service operation authority lost",
  );
  expect(f.events).toEqual(["status", "observe:ready"]);
  expect(f.stop).not.toHaveBeenCalled();
});

it("rejects a replacement boot before sending suspension or stopping", async () => {
  const f = fixture({ bootId: (method) => (method === "status" ? "resident" : "replacement") });
  await expect(withGatewayMaintenanceDrain(f.params, f.stop)).rejects.toThrow(
    "Gateway process changed",
  );
  expect(f.events).toEqual(["status"]);
  expect(f.stop).not.toHaveBeenCalled();
});

const juneStaleConnection = "gateway closed (1011): gateway message handler unavailable";
const legacyResident = { pid: 42, state: "alive", path: "/tmp/openclaw-fixture/gateway.lock" };

function staleConnectionError(message: string) {
  return message === juneStaleConnection
    ? createGatewayCloseTransportError({
        code: 1011,
        reason: "gateway message handler unavailable",
        connectionDetails: {
          url: "ws://127.0.0.1:18789",
          urlSource: "local loopback",
          message: "Gateway target: ws://127.0.0.1:18789",
        },
        requestDispatched: false,
      })
    : new Error(message);
}

it.each([GATEWAY_STALE_INSTALL_CLOSE_REASON, juneStaleConnection])(
  "stops an identified replaced resident without draining: %s",
  async (reason) => {
    const f = fixture();
    mocks.legacyLock.mockResolvedValue(legacyResident);
    mocks.call.mockImplementation(async () => {
      throw staleConnectionError(reason);
    });
    const { timeoutMs: _timeoutMs, ...params } = f.params;
    const running = withGatewayMaintenanceDrain(params, f.stop);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.stop).toHaveBeenCalledOnce();
    await expect(running).resolves.toBe("stopped");
    expect(f.events).toEqual([
      expect.stringMatching(/^warning:.*replaced before this stop/),
      "stop",
    ]);
    if (reason === GATEWAY_STALE_INSTALL_CLOSE_REASON) {
      expect(mocks.legacyLock).not.toHaveBeenCalled();
      expect(mocks.portUsage).not.toHaveBeenCalled();
    }
  },
);

it.each([GATEWAY_STALE_INSTALL_CLOSE_REASON, juneStaleConnection])(
  "stops an identified resident replaced during the drain: %s",
  async (reason) => {
    const f = fixture({ observations: [draining("embedded-run", "1 active agent turn")] });
    mocks.legacyLock.mockResolvedValue(legacyResident);
    let calls = 0;
    const base = mocks.call.getMockImplementation();
    mocks.call.mockImplementation(async (request) => {
      if (request.method === "gateway.suspend.prepare" && ++calls > 1) {
        throw staleConnectionError(reason);
      }
      return base?.(request);
    });
    const running = withGatewayMaintenanceDrain(f.params, f.stop);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.events).toEqual(["status", "observe:draining"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.stop).toHaveBeenCalledOnce();
    await expect(running).resolves.toBe("stopped");
    expect(f.events.at(-1)).toBe("stop");
    expect(f.events.at(-2)).toMatch(/^warning:.*replaced during this stop/);
  },
);

it.each([
  ["absent", undefined],
  ["unverified", { ...legacyResident, state: "unknown" }],
  ["different PID", { ...legacyResident, pid: 43 }],
])("keeps the normal deadline with a %s legacy lock", async (_label, legacy) => {
  const f = fixture();
  mocks.legacyLock.mockResolvedValue(legacy);
  mocks.call.mockRejectedValue(staleConnectionError(juneStaleConnection));
  const running = withGatewayMaintenanceDrain(f.params, f.stop);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.stop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(f.params.timeoutMs);
  await expect(running).resolves.toBe("stopped");
  expect(f.warn).toHaveBeenCalledWith(expect.stringContaining("drain deadline reached"));
});

it.each([
  "unknown method: gateway.suspend.prepare",
  "device identity required",
  "gateway closed (1011): unrelated failure",
  "gateway closed (1011): gateway message handler unavailable for another reason",
])("does not shorten the deadline for %s", async (message) => {
  const f = fixture();
  mocks.legacyLock.mockResolvedValue(legacyResident);
  mocks.call.mockRejectedValue(new Error(message));
  const running = withGatewayMaintenanceDrain(f.params, f.stop);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.stop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(f.params.timeoutMs);
  await expect(running).resolves.toBe("stopped");
  expect(mocks.legacyLock).not.toHaveBeenCalled();
  expect(f.warn).toHaveBeenCalledWith(expect.stringContaining("drain deadline reached"));
});

it.each<PortUsage>([
  { port: 18789, status: "free", listeners: [], hints: [] },
  { port: 18789, status: "unknown", listeners: [], hints: [] },
  { port: 18789, status: "busy", listeners: [{}], hints: [] },
  { port: 18789, status: "busy", listeners: [{ pid: 43 }], hints: [] },
  { port: 18789, status: "busy", listeners: [{ pid: 42 }, { pid: 43 }], hints: [] },
])("does not shorten the June deadline without owned listener attribution: %j", async (usage) => {
  const f = fixture();
  mocks.legacyLock.mockResolvedValue(legacyResident);
  mocks.portUsage.mockResolvedValue(usage);
  mocks.call.mockRejectedValue(staleConnectionError(juneStaleConnection));
  const running = withGatewayMaintenanceDrain(f.params, f.stop);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.stop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(f.params.timeoutMs);
  await expect(running).resolves.toBe("stopped");
  expect(f.warn).toHaveBeenCalledWith(expect.stringContaining("drain deadline reached"));
});

it.each(["plain error", "protocol response", "extended close reason"])(
  "does not shorten the June deadline for a %s lookalike",
  async (kind) => {
    const f = fixture();
    mocks.legacyLock.mockResolvedValue(legacyResident);
    let error: Error;
    if (kind === "protocol response") {
      const response = new GatewayProtocolRequestError({
        code: "UNAVAILABLE",
        message: juneStaleConnection,
      });
      retainGatewayResponsePayload(response, undefined);
      error = response;
    } else if (kind === "extended close reason") {
      error = createGatewayCloseTransportError({
        code: 1011,
        reason: "gateway message handler unavailable\nfor a different reason",
        connectionDetails: {
          url: "ws://127.0.0.1:18789",
          urlSource: "local loopback",
          message: "Gateway target: ws://127.0.0.1:18789",
        },
        requestDispatched: false,
      });
    } else {
      error = new Error(juneStaleConnection);
    }
    mocks.call.mockRejectedValue(error);
    const running = withGatewayMaintenanceDrain(f.params, f.stop);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(f.params.timeoutMs);
    await expect(running).resolves.toBe("stopped");
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining("drain deadline reached"));
  },
);

it.each(["listener", "authority"])(
  "does not stop when %s changes during June listener revalidation",
  async (change) => {
    const f = fixture();
    mocks.legacyLock.mockResolvedValue(legacyResident);
    mocks.call.mockRejectedValue(staleConnectionError(juneStaleConnection));
    mocks.portUsage
      .mockResolvedValueOnce({
        port: 18789,
        status: "busy",
        listeners: [{ pid: 42 }],
        hints: [],
      })
      .mockImplementationOnce(async () => {
        if (change === "authority") {
          f.loseAuthority();
        }
        return { port: 18789, status: "busy", listeners: [{ pid: 43 }], hints: [] };
      });
    await expect(withGatewayMaintenanceDrain(f.params, f.stop)).rejects.toThrow(
      change === "authority"
        ? "service operation authority lost"
        : "Legacy Gateway listener changed",
    );
    expect(f.stop).not.toHaveBeenCalled();
  },
);

it.each(["lock", "native PID", "authority"])(
  "does not stop when %s changes during legacy revalidation",
  async (change) => {
    const f = fixture();
    mocks.call.mockRejectedValue(staleConnectionError(juneStaleConnection));
    mocks.legacyLock.mockResolvedValueOnce(legacyResident).mockImplementationOnce(async () => {
      if (change === "lock") {
        return undefined;
      }
      if (change === "native PID") {
        f.params.state.runtime = { status: "running", pid: 43 };
      } else {
        f.loseAuthority();
      }
      return legacyResident;
    });
    await expect(withGatewayMaintenanceDrain(f.params, f.stop)).rejects.toThrow(
      change === "authority"
        ? "service operation authority lost"
        : "Legacy Gateway identity changed",
    );
    expect(f.stop).not.toHaveBeenCalled();
  },
);
