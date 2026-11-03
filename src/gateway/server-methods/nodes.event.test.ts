import assert from "node:assert/strict";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred, nextEventLoopTurn } from "../../../test/helpers/promise.js";
import { createMemorySessionActorOwner } from "../../config/sessions/session-actor-memory.js";
import {
  getSessionActorStorageBinding,
  runWithSessionActorStorage,
} from "../../config/sessions/session-actor-storage-binding.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "../server-chat-state.js";
import { buildNodeEventContext, runtimeMocks } from "../server-node-events.test-support.js";
import { createGatewayNodeSessionRuntime } from "../server-node-session-runtime.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { nodeEventHandlers } from "./nodes.event.js";
import { expectNodeReply, invokeNodeRequest } from "./nodes.invoke.test-support.js";
import { createWorkerSupervisorNodeClient } from "./nodes.runner-inventory.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const { recordHostStatsMock } = vi.hoisted(() => ({ recordHostStatsMock: vi.fn() }));
vi.mock("../../infra/device-pairing-node.js", () => ({
  recordPairedNodeHostStats: recordHostStatsMock,
}));
afterEach(() => vi.restoreAllMocks());

it("keeps the accepted event result independent of persistence", async () => {
  const stats = { cpuCount: 2, memoryTotalBytes: 4096, memoryFreeBytes: 1024 };
  const hostStats = { ...stats, updatedAtMs: 1_250 };
  const persistence = createDeferred<boolean>();
  recordHostStatsMock.mockReset().mockReturnValue(persistence.promise);
  vi.spyOn(Date, "now").mockReturnValue(1_250);
  const h = new NodeEventHarness();
  const client = h.register("conn-1");
  const { broadcast } = h;
  const respond = await h.send(client, stats, "node.host.stats");

  const result = { ok: true, event: "node.host.stats", handled: true, reason: "updated" };
  // The RPC has already completed while its store write is still pending.
  expect(respond).toHaveBeenCalledExactlyOnceWith(true, result, undefined);
  expect(recordHostStatsMock).toHaveBeenCalledExactlyOnceWith({
    nodeId: "node-1",
    hostStats,
    expectedPairingGeneration: { nodeId: "node-1", key: h.binding.generation },
  });
  expect(broadcast).toHaveBeenCalledWith(
    "node.hostStats",
    { nodeId: "node-1", hostStats },
    { dropIfSlow: true },
  );
  persistence.reject(new Error("stats store unavailable"));
  await persistence.promise.catch(() => undefined);
  expect(respond).toHaveBeenCalledExactlyOnceWith(true, result, undefined);
});
it.each([
  { message: "x".repeat(20_001), reason: "message_too_large", handled: false },
  { message: "x".repeat(20_000), reason: "accepted", handled: true },
  {
    message: "read this",
    attachments: [
      { type: "file", mimeType: "application/pdf", fileName: "a.pdf", content: "JVBERi0=" },
    ],
    reason: "invalid_attachments",
    handled: false,
  },
])("reports agent request admission through node.event ($reason)", async (scenario) => {
  const { parseMessageWithAttachments } =
    await vi.importActual<typeof import("../chat-attachments.js")>("../chat-attachments.js");
  runtimeMocks.parseMessageWithAttachments.mockImplementation(parseMessageWithAttachments);
  runtimeMocks.persistInboundImagesForTranscript.mockResolvedValue({
    entries: [],
    omission: "none",
  });
  runtimeMocks.upsertSessionEntryCore.mockImplementation(async (_scope, patch) => patch);
  const work = createDeferred();
  runtimeMocks.agentCommandFromIngress.mockReset().mockReturnValue(work.promise);
  const h = new NodeEventHarness();
  Object.assign(h.context, buildNodeEventContext(), { logGateway: { warn: h.warn } });
  const client = h.register("share-connection", "share-node", "openclaw-ios", "ios");
  try {
    const respond = await h.send(
      client,
      {
        message: scenario.message,
        sessionKey: "agent:main:share-admission",
        attachments: scenario.attachments,
      },
      "agent.request",
    );
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      true,
      {
        ok: true,
        event: "agent.request",
        handled: scenario.handled,
        reason: scenario.reason,
      },
      undefined,
    );
    if (scenario.handled) {
      expect(runtimeMocks.agentCommandFromIngress).toHaveBeenCalledOnce();
      expect(runtimeMocks.agentCommandFromIngress.mock.calls[0]?.[0]).toMatchObject({
        message: scenario.message,
      });
    } else {
      expect(runtimeMocks.agentCommandFromIngress).not.toHaveBeenCalled();
    }
  } finally {
    work.resolve();
  }
});

it("admits an incognito share before the agent finishes and retains its actor custody", async () => {
  const sessionKey = "agent:main:dashboard:incognito-share-admission";
  const location = {
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: "/synthetic-share-state" },
    }),
  };
  const owner = createMemorySessionActorOwner(location);
  onTestFinished(() => owner.close());
  const authority = { assertCurrent() {}, authorize() {} };
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey },
    {
      assertCurrent() {},
      assertReadable() {},
    },
  );
  onTestFinished(() => actor.release());
  assert(actor.storage);
  await actor.storage.mutate(
    {
      type: "session.entry.create",
      input: {
        entry: { sessionId: "private-share", updatedAt: 1, incognito: true },
      },
    },
    authority,
  );
  runtimeMocks.persistInboundImagesForTranscript.mockResolvedValue({
    entries: [],
    omission: "none",
  });
  runtimeMocks.upsertSessionEntryCore.mockImplementation(async (_scope, patch) => patch);
  const work = createDeferred();
  const dispatched = createDeferred();
  runtimeMocks.agentCommandFromIngress.mockReset().mockImplementation(async () => {
    dispatched.resolve();
    await work.promise;
    // Resume after the admission response, through the binding inherited by accepted work.
    const retained = getSessionActorStorageBinding({ sessionKey });
    assert(retained);
    const result = await retained.actor.storage.mutate(
      {
        type: "session.entry.patch",
        input: { operation: { kind: "fields", patch: { label: "Written after admission" } } },
      },
      retained.authority,
    );
    expect(result.kind).toBe("committed");
  });
  const h = new NodeEventHarness();
  Object.assign(h.context, buildNodeEventContext());
  const client = h.register("private-share-connection");
  const respond = vi.fn();
  const params = { event: "agent.request", payload: { sessionKey, message: "private share" } };
  let finished = false;
  const done = runWithSessionActorStorage({ actor, authority, ...location }, async () =>
    nodeEventHandlers["node.event"]!({
      req: { type: "req", id: "private-share", method: "node.event", params },
      params,
      context: h.context,
      client,
      respond,
      isWebchatConnect: () => false,
    }),
  ).then(() => {
    finished = true;
  });
  try {
    await dispatched.promise;
    await nextEventLoopTurn();
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      true,
      {
        ok: true,
        event: "agent.request",
        handled: true,
        reason: "accepted",
      },
      undefined,
    );
    expect(finished).toBe(false);
  } finally {
    work.resolve();
    await done;
    expect(
      actor.storage.readCurrent({ type: "session.entry.read", input: { sessionKey } }, authority),
    ).toMatchObject({ sessionId: "private-share", label: "Written after admission" });
  }
  expect(respond).toHaveBeenCalledTimes(1);
});

class NodeEventHarness {
  binding = { identity: "identity-1", generation: "generation-1" };
  resolvePairing = vi.fn(async () => this.binding);
  broadcast = vi.fn();
  warn = vi.fn();
  runtime = createGatewayNodeSessionRuntime({
    broadcast: this.broadcast,
    resolveCurrentPairingState: this.resolvePairing,
    isPairingStateCurrent: () => true,
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
  });
  context = {
    ...this.runtime,
    broadcast: this.broadcast,
    logGateway: { warn: this.warn },
  } as unknown as GatewayRequestHandlerOptions["context"];
  nodeRegistry = this.runtime.nodeRegistry;
  register(connId: string, nodeId = "node-1", clientId = "openclaw-macos", platform = "darwin") {
    const client = createWorkerSupervisorNodeClient(connId);
    Object.assign(client.connect, {
      role: "node",
      scopes: [],
      commands: [],
      device: { id: nodeId },
    });
    Object.assign(client.connect.client, { id: clientId, platform });
    this.nodeRegistry.register(client, {
      pairingIdentity: this.binding.identity,
      pairingGeneration: this.binding.generation,
    });
    onTestFinished(() => {
      this.nodeRegistry.unregister(connId);
    });
    return client;
  }
  send(client: GatewayWsClient, payload: unknown, event = "node.desktop.availability") {
    return invokeNodeRequest(
      nodeEventHandlers["node.event"]!,
      this.context,
      client,
      "node.event",
      { event, payload },
      "desktop-state",
    );
  }
  changes = () =>
    this.broadcast.mock.calls
      .filter(([event]) => event === "node.runnerInventory.changed")
      .map(([, payload]) => payload);
  node = () => this.nodeRegistry.get("node-1");
  active = () => this.nodeRegistry.getActiveNode();
}

it.each([
  "current",
  "foreign-node",
  "owner-epoch",
  "placement-generation",
  "moving",
  "reconnected",
  "payload-key",
])(
  "publishes worker process invalidations only for the current placement (%s)",
  async (scenario) => {
    const h = new NodeEventHarness();
    const client = h.register("process-node");
    const placement = {
      state: "active",
      executionMode: "worker-turn",
      environmentId: "environment-1",
      sessionId: "session-1",
      sessionKey: "agent:main:build",
      agentId: "main",
      activeOwnerEpoch: 3,
      generation: 2,
    };
    const environment = {
      nodeDeviceId: scenario === "foreign-node" ? "another-node" : "node-1",
      ownerEpoch: scenario === "owner-epoch" ? 4 : 3,
      state: "attached",
      destroyRequestedAtMs: null,
    };
    const release = vi.fn();
    const prepareRuntimeRefresh = vi.fn(async () => {
      if (scenario === "reconnected") {
        h.register("replacement-node");
      }
      return {
        placement,
        ...(scenario === "moving" ? { move: {} } : {}),
        assertCurrent() {},
        release,
      };
    });
    Object.assign(h.context, {
      workerSessionPlacementService: { prepareRuntimeRefresh },
      workerEnvironmentService: { get: () => environment },
    });
    const respond = await h.send(
      client,
      {
        environmentId: "environment-1",
        sessionId: "session-1",
        ownerEpoch: 3,
        placementGeneration: scenario === "placement-generation" ? 1 : 2,
        ...(scenario === "payload-key" ? { sessionKey: "agent:main:untrusted" } : {}),
      },
      "worker.processes.changed",
    );
    expectNodeReply(respond, {
      ok: true,
      event: "worker.processes.changed",
      handled: scenario === "current",
    });
    if (scenario === "current") {
      expect(h.broadcast).toHaveBeenCalledExactlyOnceWith(
        "sessions.processes.changed",
        { sessionKey: "agent:main:build", agentId: "main" },
        { sessionKeys: ["agent:main:build"], agentId: "main", dropIfSlow: true },
      );
    } else {
      expect(h.broadcast).not.toHaveBeenCalled();
    }
    if (scenario === "payload-key") {
      expect(prepareRuntimeRefresh).not.toHaveBeenCalled();
    } else {
      expect(release).toHaveBeenCalledOnce();
    }
  },
);

it("invalidates only the reporting node's inventory on state changes and connection retirement", async () => {
  const h = new NodeEventHarness();
  const first = h.register("conn-first");
  h.register("conn-other", "node-other");
  expectNodeReply(await h.send(first, { state: "locked" }), {
    ok: true,
    event: "node.desktop.availability",
    handled: true,
    reason: "updated",
  });
  expect(h.node()).toMatchObject({ desktopAvailability: { state: "locked" } });
  expect(h.nodeRegistry.get("node-other")).not.toHaveProperty("desktopAvailability");
  const unchanged = await h.send(first, { state: "locked" });
  expect(unchanged.mock.calls[0]?.[1]).toMatchObject({ handled: true, reason: "unchanged" });
  expect(h.changes()).toEqual([{ nodeId: "node-1" }]);

  const replacement = h.register("conn-replacement");
  expect(h.node()).not.toHaveProperty("desktopAvailability");
  expect(h.changes()).toHaveLength(2);
  const retiredCount = h.changes().length;
  expect(h.changes().at(-1)).toEqual({ nodeId: "node-1" });
  const stale = await h.send(first, { state: "locked" });
  expect(stale.mock.calls[0]?.[0]).toBe(false);
  expect(h.nodeRegistry.unregister(first.connId)).toBeNull();
  expect(h.changes()).toHaveLength(retiredCount);
  await h.send(replacement, { state: "unlocked" });
  expect(h.changes()).toHaveLength(3);
  expect(h.nodeRegistry.unregister(replacement.connId)).toBe("node-1");
  expect(h.node()).toBeUndefined();
  expect(h.changes()).toHaveLength(4);
  expect(h.changes().at(-1)).toEqual({ nodeId: "node-1" });
});

it("rejects malformed states and attempts to supply another node identity", async () => {
  const h = new NodeEventHarness();
  const client = h.register("conn-1");
  for (const payload of [null, [], {}, { state: "idle" }, { state: "locked", nodeId: "other" }]) {
    const respond = await h.send(client, payload);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      handled: false,
      reason: "invalid_payload",
    });
  }
  expect(h.node()).not.toHaveProperty("desktopAvailability");
  expect(h.changes()).toEqual([]);
});

it.each(["replaced", "closed"])(
  "rejects an event whose connection is %s while pairing validation is pending",
  async (retirement) => {
    const h = new NodeEventHarness();
    const client = h.register("conn-first");
    const pending = createDeferred<typeof h.binding>();
    h.resolvePairing.mockReturnValueOnce(pending.promise);
    const receipt = h.send(client, { state: "locked" });
    await vi.waitFor(() => expect(h.resolvePairing).toHaveBeenCalledOnce());
    const replacement = retirement === "replaced" ? h.register("conn-replacement") : undefined;
    if (!replacement) {
      Object.defineProperty(client.socket, "readyState", { value: 3 });
    }
    pending.resolve(h.binding);
    const response = (await receipt).mock.calls[0];
    if (replacement) {
      expect(response?.[0]).toBe(false);
    } else {
      expect(response?.[1]).toMatchObject({ handled: false, reason: "stale_connection" });
    }
    expect(h.node()).not.toHaveProperty("desktopAvailability");
    expect(h.changes()).toEqual([]);
    if (!replacement) {
      return;
    }
    await h.send(replacement, { state: "unlocked" });
    expect(h.changes()).toHaveLength(1);
    h.nodeRegistry.invalidateConnectionForPairingChange(replacement.connId);
    expect(h.changes()).toHaveLength(2);
    expect(h.changes().at(-1)).toEqual({ nodeId: "node-1" });
    expect((await h.send(replacement, { state: "locked" })).mock.calls[0]?.[0]).toBe(false);
  },
);
it("preserves app presence on Accessibility revocation and replaces system activity on fallback", async () => {
  const h = new NodeEventHarness();
  const client = h.register("conn-1");
  const node = h.node()!;
  node.declaredPermissions = { accessibility: true };
  h.nodeRegistry.updateSurface("node-1", { commands: [], permissions: { accessibility: true } });
  const clock = vi.spyOn(Date, "now");
  for (const [now, idleSeconds, source, lastActiveAtMs] of [
    [100_000, 0, undefined, 100_000],
    [105_000, 20, "app", 85_000],
    [106_000, 30, "app", 85_000],
  ] as const) {
    clock.mockReturnValue(now);
    await h.send(client, { idleSeconds, source }, "node.presence.activity");
    expect(h.active()).toMatchObject({
      lastActiveAtMs,
      presenceActivitySource: source ?? "system",
    });
  }
  h.nodeRegistry.updateSurface("node-1", { commands: [], permissions: { accessibility: false } });
  expect(h.active()?.lastActiveAtMs).toBe(85_000);
});

it.each([
  { source: "app", clientId: "openclaw-macos", platform: "darwin", accepted: true },
  { source: "app", clientId: "openclaw-macos", platform: "macOS 26.0.1", accepted: true },
  { source: "system", clientId: "openclaw-macos", platform: "darwin", accepted: false },
  { source: "app", clientId: "node-host", platform: "darwin", accepted: false },
  { source: "app", clientId: "openclaw-macos", platform: "linux", accepted: false },
])(
  "accepts only native Mac app activity without Accessibility ($source, $clientId, $platform)",
  async ({ source, clientId, platform, accepted }) => {
    const h = new NodeEventHarness();
    const client = h.register("conn-1", "node-1", clientId, platform);
    const respond = await h.send(client, { idleSeconds: 0, source }, "node.presence.activity");
    expect(respond.mock.calls[0]?.[1]).toMatchObject({ handled: accepted });
    expect(h.active()?.nodeId).toBe(accepted ? "node-1" : undefined);
  },
);
