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
// mock-isolation: Drain policy uses explicit fixture credentials, independent of device storage.
vi.mock("../daemon-cli/restart-health-probe.js", () => ({
  resolveGatewayRestartProbeContext: async () => ({
    config: {},
    auth: { token: "fixture-token" },
  }),
}));
vi.mock("./update-command-service-plan.js", () => ({
  resolveUpdatedGatewayRestartPort: async () => 18789,
}));

const { withGatewayMaintenanceDrain } = await import("./update-command-service-drain.js");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
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
    expiresAtMs: Date.now() + 120_000,
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
    expiresAtMs: Date.now() + 120_000,
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
  const stop = vi.fn(
    async ({ prepareEffect }: { prepareEffect: (beforeCommit: () => void) => Promise<void> }) => {
      await prepareEffect(() => {});
      events.push("stop");
      return "stopped";
    },
  );
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
      return { pid: 42, processInstanceId: "resident-instance" };
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
    if (request.method === "gateway.suspend.handoff") {
      events.push("handoff");
      const observed = observations.at(-1);
      return {
        status: "committed",
        suspensionId: "resident-suspension",
        expiresAtMs: observed?.status !== "busy" ? observed?.expiresAtMs : undefined,
      };
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

it.each([
  { residentTimeout: undefined, managerTimeout: 330_000, drain: true, warning: false },
  { residentTimeout: 325_000, managerTimeout: 330_000, drain: false, warning: false },
  { residentTimeout: 325_000, managerTimeout: 30_000, drain: true, warning: true },
  { residentTimeout: 325_000, managerTimeout: undefined, drain: true, warning: true },
])(
  "stops an idle resident with budgets $residentTimeout/$managerTimeout",
  async ({ residentTimeout, managerTimeout, drain, warning }) => {
    const f = fixture({
      resident: {
        pid: 42,
        ...(residentTimeout === undefined
          ? {}
          : { shutdownBudget: { timeoutMs: residentTimeout } }),
      },
    });
    mocks.managerTimeout.mockResolvedValue(managerTimeout);
    await expect(withGatewayMaintenanceDrain(f.params, f.stop)).resolves.toBe("stopped");
    expect(f.events.filter((event) => !event.startsWith("warning:"))).toEqual(
      drain ? ["status", "observe:ready", "stop"] : ["status", "stop"],
    );
    if (warning) {
      expect(f.warn).toHaveBeenCalledOnce();
      expect(f.warn.mock.calls[0]?.[0]).toContain("using lifecycle drain");
    } else {
      expect(f.warn).not.toHaveBeenCalled();
    }
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

it.each(["admitted work", "published resident", "expired observation"] as const)(
  "warns before stopping at the drain deadline: %s",
  async (scenario) => {
    const observation: GatewaySuspendPrepareResult =
      scenario === "admitted work"
        ? draining("embedded-run", "1 active agent turn", DEFAULT_UPDATE_STEP_TIMEOUT_MS)
        : scenario === "published resident"
          ? {
              ...draining("root-request", "2 active gateway requests"),
              writeCustody: undefined,
              activeCount: 5,
              blockers: [
                { kind: "root-request", count: 2, message: "2 active gateway requests" },
                { kind: "cron-run", count: 3, message: "3 active cron runs" },
              ],
            }
          : {
              ...draining("cron-run", "1 active cron run"),
              writeCustody: [{ phase: "backup", count: 1 }],
            };
    const f = fixture({
      observations: [observation],
      ...(scenario === "published resident" ? { resident: { pid: 42 } } : {}),
    });
    if (scenario === "expired observation") {
      const call = expectDefined(
        mocks.call.getMockImplementation(),
        "Missing Gateway call fixture",
      );
      let observations = 0;
      mocks.call.mockImplementation(async (request: CallGatewayCliOptions) => {
        if (request.method === "gateway.suspend.prepare" && observations++ > 0) {
          throw new Error("resident unavailable");
        }
        return await call(request);
      });
    }
    const timeoutMs = scenario === "admitted work" ? undefined : f.params.timeoutMs;
    const running = withGatewayMaintenanceDrain({ ...f.params, timeoutMs }, f.stop);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS);
    await expect(running).resolves.toBe("stopped");
    expect(f.warn).toHaveBeenCalledOnce();
    expect(f.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        scenario === "admitted work"
          ? /25000ms.*1 active agent turn.*interrupted.*330s/
          : scenario === "published resident"
            ? /WARNING:.*budget unknown.*root-request=2, cron-run=3.*cannot distinguish migrations\/backups from ordinary work.*next Gateway starts with a 330s/
            : /cron-run=1.*Current lifecycle observation unavailable.*resident unavailable/,
      ),
    );
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.events.at(-1)).toBe("stop");
    expect(f.events.at(-2)).toMatch(/^warning:/);
  },
);

it.each(["session-mutation", "backup"] as const)(
  "refuses deadline custody in %s and releases the suspension with a full final RPC budget",
  async (phase) => {
    const f = fixture({
      observations: [
        phase === "session-mutation"
          ? draining(phase, `1 active ${phase} owner`)
          : { ...draining("root-request", "1 request"), writeCustody: [{ phase, count: 1 }] },
      ],
    });
    if (phase === "backup") {
      const call = expectDefined(
        mocks.call.getMockImplementation(),
        "Missing Gateway call fixture",
      );
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
    }
    const outcome = withGatewayMaintenanceDrain(f.params, f.stop).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(f.params.timeoutMs + (phase === "backup" ? 100 : 0));
    const error = await outcome;
    expect(error).toBeInstanceOf(GatewayServiceStopUnsafeError);
    expect(error).toMatchObject({ message: expect.stringContaining(`owner phase ${phase} (1)`) });
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

it.each(["ready", "draining"] as const)(
  "requires the %s suspension before an immutable stop despite adequate native budgets",
  async (phase) => {
    const f = fixture({
      resident: { pid: 42, shutdownBudget: { timeoutMs: 325_000 } },
      observations: [phase === "ready" ? ready() : draining("embedded-run", "1 active turn")],
    });
    const running = withGatewayMaintenanceDrain(
      { ...f.params, drainPolicy: "interrupt-after-drain" },
      f.stop,
    );
    await vi.advanceTimersByTimeAsync(0);
    if (phase === "draining") {
      expect(f.stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(f.params.timeoutMs);
      expect(mocks.call).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "gateway.suspend.handoff",
          params: {
            suspensionId: "resident-suspension",
            target: { pid: 42, processInstanceId: "resident-instance" },
            commit: true,
          },
        }),
      );
      expect(f.events.indexOf("handoff")).toBeLessThan(f.events.indexOf("stop"));
    }
    await expect(running).resolves.toBe("stopped");
    expect(f.events.indexOf("handoff")).toBeLessThan(f.events.indexOf("stop"));
    expect(f.events[1]).toBe(`observe:${phase}`);
    expect(f.stop).toHaveBeenCalledOnce();
  },
);

it.each(["busy", "expired", "unknown-custody", "held-custody", "unavailable"] as const)(
  "refuses immutable interruption with a %s lifecycle observation",
  async (reason) => {
    const observed = draining("embedded-run", "1 active turn");
    const observation: GatewaySuspendPrepareResult =
      reason === "busy"
        ? {
            status: "busy",
            reason: "gateway-draining",
            retryAfterMs: 100,
            activeCount: 1,
            blockers: [],
            writeCustody: [],
          }
        : {
            ...observed,
            ...(reason === "expired" ? { expiresAtMs: Date.now() - 1 } : {}),
            ...(reason === "unknown-custody" ? { writeCustody: undefined } : {}),
            ...(reason === "held-custody" ? { writeCustody: [{ phase: "backup", count: 1 }] } : {}),
          };
    const f = fixture({ observations: [observation] });
    if (reason === "unavailable") {
      const call = expectDefined(mocks.call.getMockImplementation(), "Missing Gateway fixture");
      let observations = 0;
      mocks.call.mockImplementation(async (request: CallGatewayCliOptions) => {
        if (request.method === "gateway.suspend.prepare" && observations++ > 0) {
          throw new Error("resident unavailable");
        }
        return await call(request);
      });
    }
    const outcome = withGatewayMaintenanceDrain(
      { ...f.params, drainPolicy: "interrupt-after-drain" },
      f.stop,
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(f.params.timeoutMs);
    expect(await outcome).toBeInstanceOf(GatewayServiceStopUnsafeError);
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.events).not.toContain("handoff");
    expect(f.events.includes("resume")).toBe(reason !== "busy");
  },
);

it.each(["refused", "legacy", "foreign", "mismatched-expiry", "stop-failed"] as const)(
  "releases its reversible suspension when native handoff is %s",
  async (failure) => {
    const f = fixture({ observations: [draining("embedded-run", "1 active turn")] });
    const call = expectDefined(mocks.call.getMockImplementation(), "Missing Gateway fixture");
    mocks.call.mockImplementation(async (request: CallGatewayCliOptions) => {
      if (request.method === "gateway.suspend.handoff") {
        if (failure === "refused") {
          throw new Error("handoff refused");
        }
        if (failure === "legacy" || failure === "foreign" || failure === "mismatched-expiry") {
          return {
            status: failure === "legacy" ? "armed" : "committed",
            suspensionId: failure === "foreign" ? "foreign" : "resident-suspension",
            expiresAtMs: failure === "mismatched-expiry" ? Date.now() - 1 : Date.now() + 120_000,
          };
        }
      }
      return await call(request);
    });
    if (failure === "stop-failed") {
      f.stop.mockRejectedValue(new Error("native stop failed"));
    }
    const outcome = withGatewayMaintenanceDrain(
      { ...f.params, drainPolicy: "interrupt-after-drain" },
      f.stop,
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(f.params.timeoutMs);
    expect(await outcome).toBeInstanceOf(Error);
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.events).not.toContain("stop");
    expect(f.events.at(-1)).toBe("resume");
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

it.each(["authority", "boot"] as const)(
  "refuses a changed %s while observing the resident",
  async (change) => {
    const f = fixture(
      change === "authority"
        ? { afterObservation: () => f.loseAuthority() }
        : { bootId: (method) => (method === "status" ? "resident" : "replacement") },
    );
    await expect(withGatewayMaintenanceDrain(f.params, f.stop)).rejects.toThrow(
      change === "authority" ? "service operation authority lost" : "Gateway process changed",
    );
    expect(f.events).toEqual(change === "authority" ? ["status", "observe:ready"] : ["status"]);
    expect(f.stop).not.toHaveBeenCalled();
  },
);

const juneStaleConnection = "gateway closed (1011): gateway message handler unavailable";
const legacyResident = { pid: 42, state: "alive", path: "/tmp/openclaw-fixture/gateway.lock" };

async function expectNormalDeadline(f: ReturnType<typeof fixture>) {
  const running = withGatewayMaintenanceDrain(f.params, f.stop);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.stop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(f.params.timeoutMs);
  await expect(running).resolves.toBe("stopped");
  expect(f.warn).toHaveBeenCalledWith(expect.stringContaining("drain deadline reached"));
}

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

it.each(
  (["before", "during"] as const).flatMap((phase) =>
    [GATEWAY_STALE_INSTALL_CLOSE_REASON, juneStaleConnection].map((reason) => ({ phase, reason })),
  ),
)("stops an identified resident replaced $phase the drain: $reason", async ({ phase, reason }) => {
  const f = fixture(
    phase === "during" ? { observations: [draining("embedded-run", "1 active agent turn")] } : {},
  );
  mocks.legacyLock.mockResolvedValue(legacyResident);
  let calls = 0;
  const base = mocks.call.getMockImplementation();
  mocks.call.mockImplementation(async (request) => {
    if (phase === "before" || (request.method === "gateway.suspend.prepare" && ++calls > 1)) {
      throw staleConnectionError(reason);
    }
    return base?.(request);
  });
  const running = withGatewayMaintenanceDrain(
    { ...f.params, timeoutMs: phase === "before" ? undefined : f.params.timeoutMs },
    f.stop,
  );
  await vi.advanceTimersByTimeAsync(0);
  if (phase === "during") {
    expect(f.events).toEqual(["status", "observe:draining"]);
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(f.stop).toHaveBeenCalledOnce();
  await expect(running).resolves.toBe("stopped");
  const warning = expect.stringMatching(new RegExp(`^warning:.*replaced ${phase} this stop`));
  expect(f.events.at(-1)).toBe("stop");
  expect(f.events.at(-2)).toEqual(warning);
  if (phase === "before") {
    expect(f.events).toEqual([warning, "stop"]);
    if (reason === GATEWAY_STALE_INSTALL_CLOSE_REASON) {
      expect(mocks.legacyLock).not.toHaveBeenCalled();
      expect(mocks.portUsage).not.toHaveBeenCalled();
    }
  }
});

it.each<{
  name: string;
  legacy?: typeof legacyResident;
  usage?: PortUsage;
}>([
  { name: "absent lock" },
  { name: "unverified lock", legacy: { ...legacyResident, state: "unknown" } },
  { name: "different lock PID", legacy: { ...legacyResident, pid: 43 } },
  {
    name: "unknown port",
    legacy: legacyResident,
    usage: { port: 18789, status: "unknown", listeners: [], hints: [] },
  },
  {
    name: "unattributed listener",
    legacy: legacyResident,
    usage: { port: 18789, status: "busy", listeners: [{}], hints: [] },
  },
  {
    name: "mixed listeners",
    legacy: legacyResident,
    usage: { port: 18789, status: "busy", listeners: [{ pid: 42 }, { pid: 43 }], hints: [] },
  },
])(
  "keeps the June deadline without owned listener attribution: $name",
  async ({ legacy, usage }) => {
    const f = fixture();
    mocks.legacyLock.mockResolvedValue(legacy);
    if (usage) {
      mocks.portUsage.mockResolvedValue(usage);
    }
    mocks.call.mockRejectedValue(staleConnectionError(juneStaleConnection));
    await expectNormalDeadline(f);
  },
);

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
    await expectNormalDeadline(f);
    expect(mocks.legacyLock).not.toHaveBeenCalled();
  },
);

it.each([
  { phase: "listener", change: "listener" },
  { phase: "listener", change: "authority" },
  { phase: "lock", change: "lock" },
  { phase: "lock", change: "native PID" },
  { phase: "lock", change: "authority" },
])(
  "does not stop when $change changes during June $phase revalidation",
  async ({ phase, change }) => {
    const f = fixture();
    mocks.call.mockRejectedValue(staleConnectionError(juneStaleConnection));
    mocks.legacyLock.mockResolvedValue(legacyResident);
    if (phase === "listener") {
      mocks.portUsage
        .mockResolvedValueOnce({ port: 18789, status: "busy", listeners: [{ pid: 42 }], hints: [] })
        .mockImplementationOnce(async () => {
          if (change === "authority") {
            f.loseAuthority();
          }
          return { port: 18789, status: "busy", listeners: [{ pid: 43 }], hints: [] };
        });
    } else {
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
    }
    await expect(withGatewayMaintenanceDrain(f.params, f.stop)).rejects.toThrow(
      change === "authority"
        ? "service operation authority lost"
        : phase === "listener"
          ? "Legacy Gateway listener changed"
          : "Legacy Gateway identity changed",
    );
    expect(f.stop).not.toHaveBeenCalled();
  },
);
