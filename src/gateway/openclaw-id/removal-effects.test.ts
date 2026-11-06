import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Progress = "queued" | "running" | undefined;

const mocks = vi.hoisted(() => ({
  entries: [] as Array<
    [
      string,
      {
        adapter: { requester?: { connectionId?: string } };
        progress: "queued" | "running" | undefined;
        sessionKey: string;
      },
    ]
  >,
  dispatch: vi.fn(async () => ({ aborted: true })),
  invalidate: vi.fn(),
  revoke: vi.fn(async () => ({ ok: true })),
  removeNodes: vi.fn(async () => ["node-device"]),
  reconcileNodes: vi.fn(async () => ["node-device"]),
  clearNode: vi.fn(),
  revokeWorker: vi.fn(async () => {}),
}));

// mock-isolation: fixed run and connection fixtures stand in for process-global Gateway state.
vi.mock("../../sessions/session-controller.rpc-sources.js", () => ({
  listRpcSourceEntries: () => mocks.entries,
  resolveRpcSourceSessionProgressState: (ref: { progress: Progress }) => ref.progress,
  getRpcSourceIdentity: (ref: { sessionKey: string }) => ({ sessionKey: ref.sessionKey }),
}));
// mock-isolation: fixed run and connection fixtures stand in for process-global Gateway state.
vi.mock("../server-in-process-dispatch.js", () => ({
  dispatchGatewayRequestInProcess: mocks.dispatch,
}));
// mock-isolation: fixed run and connection fixtures stand in for process-global Gateway state.
vi.mock("../server/ws-policy-close.js", () => ({
  invalidateGatewayPolicyClient: mocks.invalidate,
}));
// mock-isolation: fixed run and connection fixtures stand in for process-global Gateway state.
vi.mock("../../infra/device-pairing-tokens.js", () => ({ revokeDeviceToken: mocks.revoke }));

vi.mock("./node-pairing.js", () => ({
  removeNodePairings: mocks.removeNodes,
  reconcileNodePairings: mocks.reconcileNodes,
}));
vi.mock("../node-runtime-state.js", () => ({ clearRemovedNodeRuntimeState: mocks.clearNode }));
vi.mock("../device-worker-revocation.js", () => ({
  reconcileRevokedDeviceWorker: mocks.revokeWorker,
}));

const { createOpenClawIdRemovalEffects } = await import("./removal-effects.js");
const {
  openclawIdTunnelConnectionsOf,
  recordOpenClawIdTunnelConnection,
  resetOpenClawIdTunnelConnectionsForTest,
} = await import("./tunnel-connections.js");

const BOB = `iroh:${"bb".repeat(32)}`;
const ALICE = `iroh:${"aa".repeat(32)}`;
const client = (connId: string, peerKey?: string) =>
  ({ connId, internal: peerKey ? { openclawIdPeerKey: peerKey } : {} }) as never;

function run(runId: string, connectionId: string, progress: Progress, sessionKey: string) {
  return [
    runId,
    { adapter: { requester: { connectionId } }, progress, sessionKey },
  ] as (typeof mocks.entries)[number];
}

// A connection the tunnel child relayed; `closed` once its socket went away.
function relayed(connId: string, peerKey: string, closed: boolean) {
  const controller = new AbortController();
  recordOpenClawIdTunnelConnection(connId, peerKey, controller.signal);
  if (closed) {
    controller.abort();
  }
  return controller;
}

function effectsOver(clients: unknown[]) {
  return createOpenClawIdRemovalEffects({
    clients: () => clients as never,
    context: () => ({}) as never,
    log: { warn: vi.fn() },
  });
}

const abortedRunIds = () =>
  (mocks.dispatch.mock.calls as unknown as Array<[string, { runId: string }]>).map(
    ([, params]) => params.runId,
  );

beforeEach(() => {
  vi.clearAllMocks();
  resetOpenClawIdTunnelConnectionsForTest();
  mocks.entries = [
    run("run-bob", "c-bob", "running", "agent:main:bob"),
    run("run-bob-done", "c-bob", undefined, "agent:main:bob"),
    run("run-alice", "c-alice", "running", "agent:main:a"),
  ];
});

afterEach(() => {
  resetOpenClawIdTunnelConnectionsForTest();
});

describe("removal effects", () => {
  // Spec section 11 #12: removing a member mid-run cancels the run through the
  // ordinary Stop path, which keeps the transcript up to the cut.
  it("stops only the removed member's active runs, then closes its sessions", async () => {
    const effects = effectsOver([
      client("c-bob", BOB),
      client("c-alice", ALICE),
      client("c-local"),
      // Independently authenticated connections of the same person stay untouched.
      {
        connId: "c-bob-access",
        internal: {},
        authMethod: "trusted-proxy",
        authenticatedUser: "bob@example.test",
      },
      {
        connId: "c-bob-tailscale",
        internal: {},
        authMethod: "tailscale",
        authenticatedUser: "bob@example.test",
      },
    ]);
    const connections = effects.captureConnections([BOB]);
    expect(connections).toEqual(["c-bob"]);
    expect(await effects.cancelRuns?.(connections)).toBe(1);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledWith(
      "chat.abort",
      { sessionKey: "agent:main:bob", runId: "run-bob" },
      expect.objectContaining({
        client: expect.objectContaining({
          internal: expect.objectContaining({ syntheticClient: true }),
        }),
      }),
    );
    effects.closeConnections(connections);
    expect(mocks.invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ connId: "c-bob" }),
      expect.objectContaining({ reason: "openclaw-id-removed", code: 1008 }),
    );
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    await effects.revokeDeviceTokens([{ deviceId: "bob-device", role: "operator" }]);
    expect(mocks.revoke).toHaveBeenCalledWith({ deviceId: "bob-device", role: "operator" });
  });

  // OCF-210: a member who disconnects before removal keeps no runs alive.
  it("stops the runs and queued input of a member who disconnected before removal", async () => {
    relayed("c-bob-gone", BOB, true);
    mocks.entries = [
      run("run-bob-long", "c-bob-gone", "running", "agent:main:bob"),
      run("run-bob-queued", "c-bob-gone", "queued", "agent:main:bob"),
      run("run-alice", "c-alice", "running", "agent:main:a"),
    ];
    const effects = effectsOver([client("c-alice", ALICE)]);
    const connections = effects.captureConnections([BOB]);
    expect(connections).toEqual(["c-bob-gone"]);
    await effects.cancelRuns?.(connections);
    expect(abortedRunIds()).toEqual(["run-bob-long", "run-bob-queued"]);
    effects.closeConnections(connections);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it("stops runs from earlier connections after the member reconnected under a new id", async () => {
    relayed("c-bob-1", BOB, true);
    relayed("c-bob-2", BOB, false);
    mocks.entries = [
      run("run-from-first", "c-bob-1", "running", "agent:main:bob"),
      run("run-from-second", "c-bob-2", "queued", "agent:main:bob"),
      run("run-alice", "c-alice", "running", "agent:main:a"),
    ];
    const effects = effectsOver([client("c-bob-2", BOB), client("c-alice", ALICE)]);
    const connections = effects.captureConnections([BOB]);
    expect(connections.toSorted()).toEqual(["c-bob-1", "c-bob-2"]);
    await effects.cancelRuns?.(connections);
    expect(abortedRunIds().toSorted()).toEqual(["run-from-first", "run-from-second"]);
    effects.closeConnections(connections);
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ connId: "c-bob-2" }),
      expect.anything(),
    );
  });

  it("forgets a closed connection once none of its runs is unsettled", () => {
    effectsOver([]);
    relayed("c-bob-old", BOB, true);
    mocks.entries = [run("run-bob", "c-bob-old", "running", "agent:main:bob")];
    expect(openclawIdTunnelConnectionsOf([BOB])).toEqual(["c-bob-old"]);
    mocks.entries = [];
    expect(openclawIdTunnelConnectionsOf([BOB])).toEqual([]);
  });
});

it("retires node runtime, worker authority and device sessions after peer-pairing removal", async () => {
  const context = {
    invalidateClientsForDevice: vi.fn(),
    disconnectClientsForDevice: vi.fn(),
    broadcast: vi.fn(),
  };
  const effects = createOpenClawIdRemovalEffects({
    clients: () => [],
    context: () => context as never,
    log: { warn: vi.fn() },
  });
  await effects.removeNodePairings?.([BOB]);
  expect(mocks.removeNodes).toHaveBeenCalledWith([BOB]);
  expect(context.invalidateClientsForDevice).toHaveBeenCalledWith("node-device", {
    role: "node",
    reason: "device-pair-removed",
  });
  expect(mocks.clearNode).toHaveBeenCalledWith({ nodeId: "node-device", context });
  expect(mocks.revokeWorker).toHaveBeenCalledWith(context, "node-device");
  expect(context.broadcast).toHaveBeenCalledWith(
    "node.pair.resolved",
    expect.objectContaining({ nodeId: "node-device", decision: "removed" }),
    { dropIfSlow: true },
  );
  expect(context.disconnectClientsForDevice).toHaveBeenCalledWith("node-device", { role: "node" });
  const current = () => false;
  await effects.reconcileNodePairings?.(current);
  expect(mocks.reconcileNodes).toHaveBeenCalledWith(current);
});
