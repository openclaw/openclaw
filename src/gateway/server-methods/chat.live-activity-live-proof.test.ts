import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  GATEWAY_OWNER_PROFILE_ID,
  validatePushLiveActivityPrepareResult,
  type PushLiveActivityPrepareResult,
  type UsersSelfResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.js";
import {
  createHeldActivityProvider,
  withRegisteredActivityFixture,
  type ActivityDelivery,
} from "../../../test/helpers/qa-gateway-live-activity.js";
import {
  loadExactSessionEntryReadOnly,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  onAgentRuntimeEvent,
  type AgentEventPayload,
  type AgentEventRuntimePayload,
} from "../../infra/agent-events.js";
import {
  getAgentRunContext,
  getAgentRunContextOwnerStatus,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { drainAgentRunTerminalWrites } from "../../infra/agent-run-terminal-writes.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  verifyDeviceSignature,
} from "../../infra/device-identity.js";
import { approveDevicePairing } from "../../infra/device-pairing-approval.js";
import { approveNodePairing, requestNodePairing } from "../../infra/device-pairing-node.js";
import {
  getPairedDevice,
  removePairedDevice,
  requestDevicePairing,
  resolveNodePairingState,
} from "../../infra/device-pairing.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { getUserProfileListItem } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readLiveActivitySource } from "../live-activity-source.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../test-openai-responses-model.js";

it(
  "prepares the first committed running fact from authenticated chat.send before provider output",
  { timeout: 90_000 },
  async () => {
    const phaseStartedAt = performance.now();
    let providerRequests = 0;
    let providerReplies = 0;
    const markPhase = (stage: string): void => {
      process.stderr.write(
        `LIVE_ACTIVITY_PROOF ${stage} elapsedMs=${Math.round(performance.now() - phaseStartedAt)} providerRequests=${providerRequests} providerReplies=${providerReplies}\n`,
      );
    };
    markPhase("fixture.entry.before");
    try {
      await withOpenClawTestState(
        {
          scenario: "minimal",
          env: {
            OPENCLAW_GATEWAY_TOKEN: "activity-live-proof-token",
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_SKIP_GMAIL_WATCHER: "1",
            OPENCLAW_SKIP_CRON: "1",
            OPENCLAW_SKIP_CANVAS_HOST: "1",
            OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
            OPENCLAW_SKIP_PROVIDERS: "1",
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          },
        },
        async (state) => {
          markPhase("fixture.entry.after");
          const releaseProvider = createDeferred();
          const releaseTerminalWrite = createDeferred();
          const terminalWriteEntered = createDeferred();
          const session = { agentId: "main", sessionKey: "agent:main:activity-live-proof" };
          let internalRunId: string | undefined;
          let terminalEvent: AgentEventRuntimePayload | undefined;
          let blockedWrite: ReturnType<typeof patchSessionEntryCore> | undefined;
          let terminalDrain: Promise<void> | undefined;
          let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
          let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
          let unsubscribe: (() => void) | undefined;
          // Register before Gateway's observer so this real queue entry precedes
          // the canonical write, without replacing its producer or persistence owner.
          const stopTerminalObserver = onAgentRuntimeEvent((event) => {
            if (
              terminalEvent ||
              event.runId !== internalRunId ||
              event.stream !== "lifecycle" ||
              event.data.executionSettled !== true
            ) {
              return;
            }
            terminalEvent = event;
            blockedWrite = patchSessionEntryCore(
              session,
              async () => {
                terminalWriteEntered.resolve();
                await releaseTerminalWrite.promise;
                return null;
              },
              { skipMaintenance: true },
            );
          });
          const { server: providerServer, work: providerWork } = createHeldActivityProvider(
            releaseProvider.promise,
            () => {
              providerRequests++;
            },
            () => {
              providerReplies++;
            },
          );

          try {
            await runQaGatewayFixture(
              async () => {
                try {
                  markPhase("provider.listen.before");
                  await new Promise<void>((resolve, reject) => {
                    providerServer.once("error", reject);
                    providerServer.listen(0, "127.0.0.1", resolve);
                  });
                  markPhase("provider.listen.after");
                  const address = providerServer.address();
                  if (!address || typeof address === "string") {
                    throw new Error("Activity proof provider did not bind a loopback port");
                  }
                  const provider = buildMockOpenAiResponsesProvider(
                    `http://127.0.0.1:${address.port}/v1`,
                  );
                  const identity = loadOrCreateDeviceIdentity({
                    path: state.statePath("activity-client.sqlite"),
                  });
                  const scopes = ["operator.admin", "operator.pairing"];
                  markPhase("device.pair.request.before");
                  const pairing = await requestDevicePairing(
                    {
                      deviceId: identity.deviceId,
                      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
                      role: "operator",
                      roles: ["operator", "node"],
                      scopes,
                      clientId: GATEWAY_CLIENT_NAMES.IOS_APP,
                      clientMode: GATEWAY_CLIENT_MODES.UI,
                      platform: "ios",
                      deviceFamily: "iPhone",
                    },
                    state.stateDir,
                  );
                  markPhase("device.pair.request.after");
                  markPhase("device.pair.approve.before");
                  expect(
                    await approveDevicePairing(
                      pairing.request.requestId,
                      { callerScopes: scopes },
                      state.stateDir,
                    ),
                  ).toMatchObject({ status: "approved" });
                  markPhase("device.pair.approve.after");
                  markPhase("node.pair.request.before");
                  const nodeRequest = await requestNodePairing(
                    { nodeId: identity.deviceId, platform: "ios", commands: [] },
                    state.stateDir,
                  );
                  markPhase("node.pair.request.after");
                  markPhase("node.pair.approve.before");
                  expect(
                    await approveNodePairing(
                      nodeRequest.request.requestId,
                      { callerScopes: scopes },
                      state.stateDir,
                    ),
                  ).toMatchObject({ node: { nodeId: identity.deviceId } });
                  markPhase("node.pair.approve.after");

                  markPhase("gateway.start.before");
                  gateway = await startGatewayWithClient({
                    cfg: {
                      agents: {
                        defaults: {
                          workspace: state.workspaceDir,
                          skipBootstrap: true,
                          model: { primary: provider.modelRef },
                          models: {
                            [provider.modelRef]: {
                              params: { transport: "sse", openaiWsWarmup: false },
                            },
                          },
                        },
                        entries: { main: { default: true } },
                      },
                      models: {
                        mode: "replace",
                        providers: { [provider.providerId]: provider.config },
                      },
                      gateway: { auth: { mode: "token", token: "activity-live-proof-token" } },
                    },
                    configPath: state.configPath,
                    token: "activity-live-proof-token",
                    clientDisplayName: "activity-proof-bootstrap",
                  });
                  markPhase("gateway.start.after");
                  markPhase("client.connect.before");
                  client = await connectGatewayClient({
                    url: `ws://127.0.0.1:${gateway.port}`,
                    token: "activity-live-proof-token",
                    deviceIdentity: identity,
                    clientName: GATEWAY_CLIENT_NAMES.IOS_APP,
                    clientDisplayName: "activity-proof-ios",
                    mode: GATEWAY_CLIENT_MODES.UI,
                    platform: "ios",
                    deviceFamily: "iPhone",
                    role: "operator",
                    scopes,
                  });
                  markPhase("client.connect.after");
                  markPhase("users.self.before");
                  const self = await client.request<UsersSelfResult>("users.self", {});
                  markPhase("users.self.after");
                  expect(self.profile.id).toBe(GATEWAY_OWNER_PROFILE_ID);
                  expect(getUserProfileListItem(self.profile.id).id).toBe(self.profile.id);
                  markPhase("device.pair.read.before");
                  const node = resolveNodePairingState(
                    await getPairedDevice(identity.deviceId, state.stateDir),
                  );
                  markPhase("device.pair.read.after");
                  if (!node?.generation) {
                    throw new Error(
                      "Activity proof requires the authenticated device's node pairing",
                    );
                  }
                  const starts: AgentEventPayload[] = [];
                  unsubscribe = onAgentRuntimeEvent((event) => {
                    if (
                      event.sessionKey === session.sessionKey &&
                      event.stream === "lifecycle" &&
                      event.data.phase === "start"
                    ) {
                      starts.push({ ...event, data: { ...event.data } });
                    }
                  });
                  markPhase("chat.send.before");
                  const started = await client.request<{ runId: string; status: string }>(
                    "chat.send",
                    {
                      sessionKey: session.sessionKey,
                      message: "Return a short acknowledgement.",
                      deliver: false,
                      idempotencyKey: "activity-live-proof-run",
                    },
                  );
                  markPhase("chat.send.after");
                  expect(started).toMatchObject({
                    runId: "activity-live-proof-run",
                    status: "started",
                  });
                  markPhase("provider.wait.before");
                  await expect.poll(() => providerRequests, { timeout: 30_000 }).toBeGreaterThan(0);
                  markPhase("provider.wait.after");
                  markPhase("canonical.start.wait.before");
                  await expect
                    .poll(() => loadExactSessionEntryReadOnly(session)?.entry, { timeout: 30_000 })
                    .toMatchObject({ status: "running", lifecycleRunId: expect.any(String) });
                  markPhase("canonical.start.wait.after");
                  const committed = loadExactSessionEntryReadOnly(session)?.entry;
                  if (!committed?.sessionId) {
                    throw new Error("Activity proof requires the actual prepared session");
                  }
                  const firstStart = starts.find(
                    (event) =>
                      event.runId === committed.lifecycleRunId &&
                      event.sessionId === committed.sessionId,
                  );
                  expect(firstStart).toBeDefined();
                  if (!firstStart) {
                    throw new Error("Running commit has no observed start for its exact producer");
                  }
                  expect(committed.startedAt).toEqual(expect.any(Number));
                  expect(committed.startedAt).toBe(firstStart.data.startedAt);
                  expect(committed.endedAt).toBeUndefined();
                  expect(providerReplies).toBe(0);

                  // A real start commit, not the chat.send ACK, must make preparation
                  // available while every provider response is still held.
                  markPhase("prepare.before");
                  const prepared = await client.request<PushLiveActivityPrepareResult>(
                    "push.liveActivity.prepare",
                    {
                      key: session.sessionKey,
                      agentId: session.agentId,
                      sessionId: committed.sessionId,
                      publicRunId: started.runId,
                    },
                  );
                  markPhase("prepare.after");
                  expect(validatePushLiveActivityPrepareResult(prepared)).toBe(true);
                  expect(prepared.binding).toMatchObject({
                    ...session,
                    sessionId: committed.sessionId,
                    lifecycleRevision: committed.lifecycleRevision ?? null,
                    publicRunId: started.runId,
                    profileId: self.profile.id,
                    deviceId: identity.deviceId,
                    nodeId: node.identity.nodeId,
                    pairingGeneration: node.generation.key,
                  });
                  expect(prepared.snapshot).toEqual({
                    sourceIncarnation: prepared.sourceIncarnation,
                    sequence: firstStart.seq,
                    status: "running",
                    observedAtMs: firstStart.ts,
                    startedAtMs: firstStart.data.startedAt,
                  });
                  expect(providerReplies).toBe(0);
                  expect(tableExists(openOpenClawStateDatabase().db, "apns_live_activities")).toBe(
                    false,
                  );

                  internalRunId = firstStart.runId;
                  const root = getAgentRunContext(internalRunId)?.delegatedAuthority;
                  if (!root) {
                    throw new Error("The real running producer has no admitted root");
                  }
                  releaseProvider.resolve();
                  await expect
                    .poll(() => terminalEvent, { timeout: 30_000 })
                    .toMatchObject({
                      runId: internalRunId,
                      contextClaimId: root.claimId,
                      lifecycleGeneration: root.lifecycleGeneration,
                      sessionId: committed.sessionId,
                      data: { phase: "end", executionSettled: true },
                    });
                  await terminalWriteEntered.promise;
                  if (!terminalEvent) {
                    throw new Error("Expected the definitive terminal from the real producer");
                  }
                  const terminalSource = readLiveActivitySource(terminalEvent);
                  if (!terminalSource) {
                    throw new Error("The definitive terminal lost its original Activity source");
                  }
                  expect(terminalSource.sourceIncarnation).toBe(prepared.sourceIncarnation);
                  let drained = false;
                  terminalDrain = drainAgentRunTerminalWrites(root.operationalRunInstance).then(
                    () => {
                      drained = true;
                    },
                  );
                  await new Promise<void>((resolve) => {
                    setImmediate(resolve);
                  });
                  expect(drained).toBe(false);
                  expect(getAgentRunContext(internalRunId)?.delegatedAuthority).toBe(root);
                  expect(validateAgentRunDelegatedAuthority(root)).toBe(true);
                  expect(
                    getAgentRunContextOwnerStatus(
                      internalRunId,
                      root.claimId,
                      root.lifecycleGeneration,
                    ),
                  ).toBe("active");
                  expect(loadExactSessionEntryReadOnly(session)?.entry).toMatchObject({
                    status: "running",
                    sessionId: committed.sessionId,
                    lifecycleRunId: internalRunId,
                  });
                  expect(loadExactSessionEntryReadOnly(session)?.entry.endedAt).toBeUndefined();
                  expect(terminalSource.entry.liveActivityFact?.snapshot?.status).toBe("running");

                  releaseTerminalWrite.resolve();
                  await blockedWrite;
                  await terminalDrain;
                  await expect
                    .poll(() => loadExactSessionEntryReadOnly(session)?.entry)
                    .toMatchObject({
                      status: "done",
                      sessionId: committed.sessionId,
                      lastRunId: started.runId,
                      startedAt: firstStart.data.startedAt,
                      endedAt: terminalEvent.data.endedAt,
                    });
                  expect(
                    loadExactSessionEntryReadOnly(session)?.entry.lifecycleRunId,
                  ).toBeUndefined();
                  expect(terminalSource.entry.liveActivityFact?.snapshot).toMatchObject({
                    sourceIncarnation: prepared.sourceIncarnation,
                    status: "done",
                    observedAtMs: terminalEvent.ts,
                    startedAtMs: firstStart.data.startedAt,
                    endedAtMs: terminalEvent.data.endedAt,
                  });
                  await expect.poll(() => validateAgentRunDelegatedAuthority(root)).toBe(false);
                  expect(tableExists(openOpenClawStateDatabase().db, "apns_live_activities")).toBe(
                    false,
                  );
                } finally {
                  markPhase("body.finally.before");
                  releaseProvider.resolve();
                  releaseTerminalWrite.resolve();
                  stopTerminalObserver();
                  unsubscribe?.();
                  await Promise.allSettled([blockedWrite, terminalDrain]);
                  markPhase("body.finally.after");
                }
              },
              async () => {
                markPhase("cleanup.client.before");
                try {
                  if (client) {
                    await disconnectGatewayClient(client);
                  }
                } finally {
                  markPhase("cleanup.client.after");
                }
              },
              async () => {
                markPhase("cleanup.bootstrap-client.before");
                try {
                  if (gateway) {
                    await disconnectGatewayClient(gateway.client);
                  }
                } finally {
                  markPhase("cleanup.bootstrap-client.after");
                }
              },
              async () => {
                markPhase("cleanup.gateway.before");
                try {
                  await gateway?.server.close();
                } finally {
                  markPhase("cleanup.gateway.after");
                }
              },
              async () => {
                markPhase("cleanup.provider.before");
                try {
                  markPhase("cleanup.provider.close.before");
                  if (providerServer.listening) {
                    await new Promise<void>((resolve, reject) => {
                      providerServer.close((error) => (error ? reject(error) : resolve()));
                      providerServer.closeAllConnections();
                    });
                  }
                  markPhase("cleanup.provider.close.after");
                  markPhase("cleanup.provider.join.before");
                  await Promise.allSettled(providerWork);
                  markPhase("cleanup.provider.join.after");
                } finally {
                  markPhase("cleanup.provider.after");
                }
              },
            );
          } finally {
            markPhase("fixture.exit.before");
          }
        },
      );
    } finally {
      markPhase("fixture.exit.after");
    }
  },
);

function expectSignedDelivery(
  delivery: ActivityDelivery | undefined,
  gateway: { deviceId: string; publicKeyPem: string },
): asserts delivery is ActivityDelivery {
  expect(delivery).toBeDefined();
  if (!delivery) {
    throw new Error("The actual relay recipient has no recorded request");
  }
  expect(delivery.method).toBe("POST");
  expect(delivery.url).toBe("/v1/push/send");
  expect(delivery.headers["x-openclaw-gateway-device-id"]).toBe(gateway.deviceId);
  const signature = delivery.headers["x-openclaw-gateway-signature"];
  const signedAt = delivery.headers["x-openclaw-gateway-signed-at-ms"];
  expect(typeof signature).toBe("string");
  expect(typeof signedAt).toBe("string");
  if (typeof signature !== "string" || typeof signedAt !== "string") {
    throw new Error("Real relay request omitted its signed headers");
  }
  const canonical = ["openclaw-relay-send-v1", gateway.deviceId, signedAt, delivery.raw].join("\n");
  expect(verifyDeviceSignature(gateway.publicKeyPem, canonical, signature)).toBe(true);
  expect(verifyDeviceSignature(gateway.publicKeyPem, `${canonical} `, signature)).toBe(false);
  expect(delivery.wire).toMatchObject({
    purpose: "liveActivity",
    revision: 1,
    pushType: "liveactivity",
  });
  expect(Object.keys(delivery.wire).toSorted()).toEqual([
    "payload",
    "priority",
    "purpose",
    "pushType",
    "relayHandle",
    "revision",
  ]);
  const { payload } = delivery.wire;
  expect(Object.keys(payload)).toEqual(["aps"]);
  expect(Object.keys(payload.aps).toSorted()).toEqual([
    "content-state",
    "event",
    "relevance-score",
    "stale-date",
    "timestamp",
  ]);
  expect(Object.keys(payload.aps["content-state"]).toSorted()).toEqual(
    (payload.aps.event === "end"
      ? ["endedAt", "observedAt", "startedAt", "status"]
      : ["observedAt", "startedAt", "status"]
    ).toSorted(),
  );
  expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThanOrEqual(2_048);
  expect(payload.aps["relevance-score"]).toBe(10);
  expect(payload.aps["stale-date"]).toBe(
    Math.floor(payload.aps["content-state"].observedAt + 978_307_200) + 240,
  );
}

it(
  "delivers signed registered activity updates and ends only after canonical terminal commit",
  { timeout: 90_000 },
  async () => {
    await withRegisteredActivityFixture(async (fixture) => {
      const prepared = await fixture.startRun();
      const foreign = await fixture.connect("foreign");
      expect(fixture.devices.foreign.profileId).not.toBe(fixture.devices.owner.profileId);
      expect(
        (await getPairedDevice(fixture.devices.foreign.identity.deviceId, fixture.state.stateDir))
          ?.tokens?.operator?.scopes,
      ).toContain("operator.write");
      await expect(fixture.prepare("foreign")).rejects.toThrow(
        `Session "${fixture.session.sessionKey}" was not found.`,
      );
      await expect(
        foreign.request("push.liveActivity.register", {
          activityId: "foreign-copy",
          expected: { binding: prepared.binding, sourceIncarnation: prepared.sourceIncarnation },
          destination: fixture.destination("owner"),
        }),
      ).rejects.toMatchObject({
        message: "Live Activity session access changed; prepare again.",
      });
      const registration = await fixture.register("owner");
      await expect.poll(() => fixture.deliveries.length, { timeout: 30_000 }).toBe(1);
      const update = fixture.deliveries[0];
      expectSignedDelivery(update, fixture.gatewayIdentity);
      expect(update.headers.authorization).toBe("Bearer fixture-grant-owner");
      expect(update.wire).toMatchObject({
        relayHandle: "handle-owner",
        priority: 5,
        payload: { aps: { event: "update", "content-state": { status: "running" } } },
      });
      const startedAt = prepared.snapshot.startedAtMs;
      if (startedAt === undefined) {
        throw new Error("Committed running fact omitted its actual start time");
      }
      expect(update.wire.payload.aps["content-state"].startedAt).toBe(
        startedAt / 1_000 - 978_307_200,
      );
      await expect
        .poll(() => fixture.row(registration.registrationId))
        .toMatchObject({ state: "active", claim_id: null, next_attempt_at_ms: null });
      await fixture.holdTerminal();
      expect(fixture.deliveries.map((entry) => entry.wire.payload.aps.event)).toEqual(["update"]);
      expect(fixture.row(registration.registrationId)).toMatchObject({
        state: "active",
        retired_at_ms: null,
      });
      await fixture.commitTerminal();
      await expect.poll(() => fixture.deliveries.length, { timeout: 30_000 }).toBe(2);
      const end = fixture.deliveries[1];
      expectSignedDelivery(end, fixture.gatewayIdentity);
      expect(end.wire).toMatchObject({
        priority: 10,
        payload: { aps: { event: "end", "content-state": { status: "completed" } } },
      });
      await expect
        .poll(() => fixture.row(registration.registrationId))
        .toMatchObject({
          state: "tombstone",
          retirement_reason: "terminal-delivered",
          destination_json: null,
          snapshot_json: null,
          claim_id: null,
          claim_runtime_id: null,
          claim_deadline_ms: null,
          claim_authorized_at_ms: null,
          next_attempt_at_ms: null,
        });
    });
  },
);

it(
  "retries an allowed binding beyond a removed device's retry deadline without sending to it",
  { timeout: 90_000 },
  async () => {
    await withRegisteredActivityFixture(async (fixture) => {
      fixture.replyWith(503);
      await fixture.startRun();
      const allowed = await fixture.register("owner");
      const removed = await fixture.register("second");
      await expect
        .poll(() => fixture.deliveries.map((entry) => entry.wire.relayHandle).toSorted())
        .toEqual(["handle-owner", "handle-second"]);
      await expect
        .poll(() =>
          [allowed, removed].map((registration) => fixture.row(registration.registrationId)),
        )
        .toEqual([
          expect.objectContaining({ next_attempt_at_ms: expect.any(Number), claim_id: null }),
          expect.objectContaining({ next_attempt_at_ms: expect.any(Number), claim_id: null }),
        ]);
      const removedDeadline = fixture.row(removed.registrationId)?.next_attempt_at_ms;
      if (typeof removedDeadline !== "number") {
        throw new Error("503 did not record a retry deadline");
      }
      const removedAttempts = fixture.deliveries.filter(
        (entry) => entry.wire.relayHandle === "handle-second",
      );
      expect(removedAttempts).toHaveLength(1);
      const client = await fixture.connect("owner");
      expect(
        await client.request("device.pair.remove", {
          deviceId: fixture.devices.second.identity.deviceId,
        }),
      ).toEqual({ deviceId: fixture.devices.second.identity.deviceId });
      await expect
        .poll(
          () =>
            fixture.deliveries.filter(
              (entry) => entry.wire.relayHandle === "handle-owner" && entry.at >= removedDeadline,
            ).length,
          { timeout: 30_000 },
        )
        .toBeGreaterThan(0);
      fixture.replyWith(200);
      expect(
        fixture.deliveries.filter((entry) => entry.wire.relayHandle === "handle-second"),
      ).toEqual(removedAttempts);
      expect(fixture.row(removed.registrationId)).toMatchObject({
        state: "tombstone",
        destination_json: null,
        snapshot_json: null,
        claim_id: null,
      });
      expect(fixture.row(allowed.registrationId)?.state).toBe("active");
      for (const delivery of fixture.deliveries) {
        expectSignedDelivery(delivery, fixture.gatewayIdentity);
      }
    });
  },
);

it(
  "restarts committed terminal retries byte-identically and retires an offline-revoked pairing",
  { timeout: 90_000 },
  async () => {
    await withRegisteredActivityFixture(async (fixture) => {
      await fixture.startRun();
      const allowed = await fixture.register("owner");
      const removed = await fixture.register("second");
      await expect.poll(() => fixture.deliveries.length).toBe(2);
      fixture.replyWith(503);
      await fixture.holdTerminal();
      await fixture.commitTerminal();
      await expect
        .poll(
          () =>
            fixture.deliveries
              .filter((entry) => entry.wire.payload.aps.event === "end")
              .map((entry) => entry.wire.relayHandle)
              .toSorted(),
          { timeout: 30_000 },
        )
        .toEqual(["handle-owner", "handle-second"]);
      await expect
        .poll(() =>
          [allowed, removed].map((registration) => fixture.row(registration.registrationId)),
        )
        .toEqual([
          expect.objectContaining({
            state: "terminal_pending",
            next_attempt_at_ms: expect.any(Number),
            claim_id: null,
          }),
          expect.objectContaining({
            state: "terminal_pending",
            next_attempt_at_ms: expect.any(Number),
            claim_id: null,
          }),
        ]);
      const firstTerminal = fixture.deliveries.find(
        (entry) =>
          entry.wire.relayHandle === "handle-owner" && entry.wire.payload.aps.event === "end",
      );
      expect(firstTerminal).toBeDefined();
      if (!firstTerminal) {
        throw new Error("No committed terminal reached the actual relay transport");
      }
      await fixture.stop();
      const attemptsBeforeRestart = fixture.deliveries.length;
      const removedRow = fixture.row(removed.registrationId);
      expect(
        await removePairedDevice(fixture.devices.second.identity.deviceId, fixture.state.stateDir),
      ).toEqual({ deviceId: fixture.devices.second.identity.deviceId });
      // The offline pairing owner does not perform the coordinator's activity cleanup.
      expect(fixture.row(removed.registrationId)).toEqual(removedRow);
      expect(removedRow?.state).toBe("terminal_pending");
      fixture.replyWith(200);
      await fixture.start();
      await expect
        .poll(() => fixture.row(allowed.registrationId), { timeout: 30_000 })
        .toMatchObject({
          state: "tombstone",
          retirement_reason: "terminal-delivered",
          destination_json: null,
          snapshot_json: null,
          claim_id: null,
        });
      const afterRestart = fixture.deliveries.slice(attemptsBeforeRestart);
      expect(afterRestart).toHaveLength(1);
      expectSignedDelivery(afterRestart[0], fixture.gatewayIdentity);
      expect(afterRestart[0].raw).toBe(firstTerminal.raw);
      expect(afterRestart[0].wire.payload.aps.timestamp).toBe(
        firstTerminal.wire.payload.aps.timestamp,
      );
      expect(fixture.row(removed.registrationId)).toMatchObject({
        state: "tombstone",
        retirement_reason: "owner-retired",
        destination_json: null,
        snapshot_json: null,
        claim_id: null,
      });
      expect(
        await getPairedDevice(fixture.devices.second.identity.deviceId, fixture.state.stateDir),
      ).toBeNull();
    });
  },
);
