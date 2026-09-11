import { createServer } from "node:http";
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
} from "../../infra/device-identity.js";
import { approveDevicePairing } from "../../infra/device-pairing-approval.js";
import { approveNodePairing, requestNodePairing } from "../../infra/device-pairing-node.js";
import {
  getPairedDevice,
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
          const providerWork = new Set<Promise<void>>();
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
          const providerServer = createServer((request, response) => {
            request.resume();
            const work = (async () => {
              providerRequests++;
              await releaseProvider.promise;
              if (response.destroyed) {
                return;
              }
              const message = {
                type: "message",
                id: "activity-live-proof-reply",
                role: "assistant",
                status: "completed",
                content: [
                  { type: "output_text", text: "Activity proof complete.", annotations: [] },
                ],
              };
              providerReplies++;
              response.writeHead(200, { "content-type": "text/event-stream" });
              response.end(
                [
                  {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: { ...message, status: "in_progress", content: [] },
                  },
                  { type: "response.output_item.done", output_index: 0, item: message },
                  {
                    type: "response.completed",
                    response: {
                      status: "completed",
                      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
                    },
                  },
                ]
                  .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                  .concat("data: [DONE]\n\n")
                  .join(""),
              );
            })()
              .catch((error: unknown) => {
                response.destroy(error instanceof Error ? error : new Error(String(error)));
              })
              .finally(() => providerWork.delete(work));
            providerWork.add(work);
          });

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
