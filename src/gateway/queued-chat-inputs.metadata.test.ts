import { beforeEach, expect, it, vi } from "vitest";
import type { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import { getRequesterProfile } from "../auto-reply/requester-profile.js";
import { getRuntimeConfig } from "../config/config.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  listSessionPendingInputs,
  loadSessionEntry,
} from "../config/sessions/session-accessor.js";
import { prepareSqliteScope } from "../config/sessions/session-accessor.sqlite-scope.js";
import { rotateAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { setDisplayName, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { useUserProfileCatalogForTest } from "../test-utils/user-profile-catalog.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { createMentionInbox } from "./mention-inbox.js";
import { readMentionInbox } from "./mention-inbox.test-support.js";
import { continueSessionQueuedInputs } from "./queued-chat-inputs.js";
import {
  setClientProfile,
  useBrowserFollowupFixture,
} from "./server-methods/chat-send-pending-inputs.test-support.js";
import { persistRunningSessionsForRestart } from "./session-restart-resume.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "./test-helpers.js";

installGatewayTestHooks();
const createBrowserFollowupFixture = useBrowserFollowupFixture();
const prepareProfileCatalog = useUserProfileCatalogForTest();
beforeEach(() => prepareProfileCatalog());
type Fixture = Awaited<ReturnType<typeof createBrowserFollowupFixture>>;
type DispatchedInput = Parameters<typeof dispatchInboundMessage>[0];

function expectStarted(response: Awaited<ReturnType<Fixture["send"]>>) {
  expect(response).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ status: "started" }),
    undefined,
    expect.anything(),
  );
}

async function createFixture() {
  const profile = ensureProfileForEmail("queued-metadata-author@example.test");
  setDisplayName(profile.id, "Queued author");
  const fixture = await createBrowserFollowupFixture({
    preserveContent: true,
    createdActor: { type: "human", source: "profile", id: profile.id },
  });
  setClientProfile(fixture.client, { ...profile, updatedAt: 1 }, "Queued author");
  const cfg = getRuntimeConfig();
  setRuntimeConfigSnapshot({
    ...cfg,
    gateway: {
      ...cfg.gateway,
      roles: {
        default: "administrator",
        definitions: {
          administrator: {
            agents: "*",
            scopes: ["operator.admin"],
            sessions: { others: "write" },
          },
          writer: { agents: "*", scopes: ["operator.write"], sessions: { others: "none" } },
        },
      },
    },
  });
  return { fixture, profile };
}

async function retireOriginalInputs(fixture: Fixture) {
  await persistRunningSessionsForRestart({ cfg: getRuntimeConfig() });
  const marker = loadSessionEntry(fixture.scope)?.resumeAfterRestart;
  if (!marker) {
    throw new Error("Expected graceful shutdown to capture the queued inputs");
  }
  rotateAgentEventLifecycleGeneration();
  await fixture.finishDispatch();
  fixture.context.dedupe.clear();
  dispatchInboundMessageMock.mockClear();
  const physical = await prepareSqliteScope(fixture.scope);
  if (!physical.path) {
    throw new Error("Expected the queued inputs' physical database");
  }
  return {
    target: { ...fixture.scope, storePath: physical.path },
    queuedInputIds: marker.queuedInputIds,
    signal: new AbortController().signal,
    assertCurrent() {},
  };
}

it("readmits accepted delivery, reply, and runtime intent with the sender's current role", async () => {
  const created = await createFixture();
  const { profile } = created;
  await using fixture = created.fixture;
  await appendTranscriptMessage(fixture.scope, {
    eventId: "quoted-answer",
    message: { role: "assistant", content: "The selected earlier answer.", timestamp: 2 },
  });
  Object.assign(fixture.params, {
    deliver: true,
    originatingChannel: "discord",
    originatingTo: "channel:queued-result",
    originatingAccountId: "queued-account",
    originatingThreadId: "queued-thread",
    replyToId: "quoted-answer",
    thinking: "high",
    fastMode: "auto",
    fastAutoOnSeconds: 7,
    timeoutMs: 90_000,
  });
  expectStarted(await fixture.send());
  const second = { ...fixture.params, idempotencyKey: "queued-after-demotion" };
  expectStarted(await fixture.send(undefined, undefined, second));
  const accepted = (await listSessionPendingInputs(fixture.scope)).items;
  expect(accepted).toHaveLength(2);
  const retained = await retireOriginalInputs(fixture);
  expect(retained.queuedInputIds).toHaveLength(2);
  const dispatched: DispatchedInput[] = [];
  dispatchInboundMessageMock.mockImplementation(async (input) => {
    dispatched.push(input);
    expect(getRequesterProfile(input.ctx)?.id).toBe(profile.id);
    await input.replyOptions?.userTurnTranscriptRecorder?.persistApproved();
    return {};
  });
  const first = accepted.find((input) => input.runId === fixture.params.idempotencyKey);
  const demoted = accepted.find((input) => input.runId === second.idempotencyKey);
  if (!first || !demoted) {
    throw new Error("Expected both accepted queued sends");
  }
  vi.mocked(fixture.context.logGateway.warn).mockClear();
  await continueSessionQueuedInputs(fixture.context, retained.target, {
    ...retained,
    queuedInputIds: [first.id],
  });
  await fixture.finishDispatch();
  expect(fixture.context.logGateway.warn).not.toHaveBeenCalled();
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]?.ctx).toMatchObject({
    OriginatingChannel: "discord",
    OriginatingTo: "channel:queued-result",
    AccountId: "queued-account",
    MessageThreadId: "queued-thread",
    ExplicitDeliverRoute: true,
    ReplyToId: "quoted-answer",
    ReplyToBody: "The selected earlier answer.",
  });
  expect(dispatched[0]?.replyOptions).toMatchObject({
    thinkingLevelOverride: "high",
    fastModeOverride: "auto",
    fastModeAutoOnSecondsOverride: 7,
    timeoutOverrideMs: 90_000,
  });
  setUserProfileRole(profile.id, "writer");
  await continueSessionQueuedInputs(fixture.context, retained.target, {
    ...retained,
    queuedInputIds: [demoted.id],
  });
  await fixture.finishDispatch();
  expect(dispatched).toHaveLength(1);
  expect((await listSessionPendingInputs(fixture.scope)).items).toMatchObject([
    { id: demoted.id, state: "cancelled" },
  ]);
});

it("publishes a retained human mention once as its freshly admitted queued principal", async () => {
  const created = await createFixture();
  const { profile } = created;
  await using fixture = created.fixture;
  const bob = ensureProfileForEmail("queued-metadata-bob@example.test");
  setDisplayName(bob.id, "Bob");
  const bobClient = { ...fixture.client, connId: "queued-mention-recipient" };
  setClientProfile(bobClient, { ...bob, updatedAt: 1 }, "Bob");
  for (const client of [fixture.client, bobClient]) {
    prepareGatewayRecipientProfile(client);
  }
  const inbox = createMentionInbox({
    scheduler: createTestGatewayScheduler(),
    gatewayInstanceId: "queued-metadata-mentions",
    getRuntimeConfig,
    getClients: () => [fixture.client, bobClient],
    broadcastToConnIds: fixture.context.broadcastToConnIds,
  });
  fixture.context.mentionInbox = inbox;
  try {
    fixture.params.message = "@Bob review the queued work.";
    fixture.params.mentions = [{ profileId: bob.id, start: 0, end: 4 }];
    expectStarted(await fixture.send());
    expect((await readMentionInbox(inbox, bobClient)).items).toEqual([]);
    const retained = await retireOriginalInputs(fixture);
    expect(retained.queuedInputIds).toHaveLength(1);
    let replayRecorder: DispatchedInput["replyOptions"];
    dispatchInboundMessageMock.mockImplementation(async (input) => {
      replayRecorder = input.replyOptions;
      expect(getRequesterProfile(input.ctx)?.id).toBe(profile.id);
      await input.replyOptions?.userTurnTranscriptRecorder?.persistApproved();
      return {};
    });
    vi.mocked(fixture.context.logGateway.warn).mockClear();
    await continueSessionQueuedInputs(fixture.context, retained.target, retained);
    await fixture.finishDispatch();
    expect(fixture.context.logGateway.warn).not.toHaveBeenCalled();
    expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
    const mentioned = (await readMentionInbox(inbox, bobClient)).items;
    expect(mentioned).toMatchObject([
      { senderProfileId: profile.id, excerpt: "@Bob review the queued work." },
    ]);
    expect((await readMentionInbox(inbox, fixture.client)).items).toEqual([]);
    await replayRecorder?.userTurnTranscriptRecorder?.persistApproved();
    await continueSessionQueuedInputs(fixture.context, retained.target, retained);
    await fixture.finishDispatch();
    expect((await readMentionInbox(inbox, bobClient)).items).toEqual(mentioned);
    expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
  } finally {
    await inbox.dispose();
  }
});
