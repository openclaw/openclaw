import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, expect, it, vi } from "vitest";
import type { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import { getRequesterProfile } from "../auto-reply/requester-profile.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  listSessionPendingInputs,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { prepareSqliteScope } from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  captureSessionQueuedInputsForRestart,
  readSessionQueuedInputPage,
} from "../config/sessions/session-pending-input-history.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
import { GatewayOperatorAccessUnavailableError } from "../infra/operator-authority-error.js";
import { GatewayDispatchUnavailableError } from "../infra/restart-recovery-errors.js";
import { createAgentDatabaseStartupObservation } from "../state/agent-database-startup-observation.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { setDisplayName, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { useUserProfileCatalogForTest } from "../test-utils/user-profile-catalog.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { createMentionInbox } from "./mention-inbox.js";
import { readMentionInbox } from "./mention-inbox.test-support.js";
import { decodeQueuedOperatorRecoverySource } from "./operator-run-recovery-source.codec.js";
import * as operatorRecovery from "./operator-run-recovery.js";
import {
  createOperatorRecoveryFixture,
  pairedOperator,
  persistDevices,
} from "./operator-run-recovery.test-support.js";
import { continueSessionQueuedInputs } from "./queued-chat-inputs.js";
import * as dashboardAuthority from "./server-methods/chat-send-dashboard-authority.js";
import {
  setClientProfile,
  useBrowserFollowupFixture,
} from "./server-methods/chat-send-pending-inputs.test-support.js";
import { GatewayRequestEntryLifetime } from "./server-request-entry.js";
import {
  persistRunningSessionsForRestart,
  resumeMarkedSessions,
} from "./session-restart-resume.js";
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
  const source = await createOperatorRecoveryFixture({
    stateDir: resolveStateDir(),
    context: fixture.context,
    profileId: profile.id,
    config: getRuntimeConfig(),
    ...fixture.scope,
    scopes: ["operator.read", "operator.write", "operator.admin"],
    device: pairedOperator(),
  });
  Object.assign(fixture.client, source.client);
  fixture.client.internal!.operatorAccessAuthority = null;
  return { fixture, profile };
}

async function retireOriginalInputs(fixture: Fixture) {
  const captured = await captureSessionQueuedInputsForRestart(fixture.scope);
  await persistRunningSessionsForRestart({ cfg: getRuntimeConfig() });
  rotateAgentEventLifecycleGeneration();
  await fixture.finishDispatch();
  fixture.context.dedupe.clear();
  dispatchInboundMessageMock.mockClear();
  const physical = await prepareSqliteScope(fixture.scope);
  if (!physical.path) {
    throw new Error("Expected the queued inputs' physical database");
  }
  return {
    queuedInputIds: captured.queuedInputIds,
    target: { ...fixture.scope, storePath: physical.path },
    signal: new AbortController().signal,
    assertCurrent() {},
  };
}

it("retains each accepted input's scope ceiling when the same person sends through another source", async () => {
  const created = await createFixture();
  await using fixture = created.fixture;
  const entryLifetime = new GatewayRequestEntryLifetime();
  fixture.context.requestEntryLifetime = entryLifetime;
  fixture.client.connect.scopes = ["operator.read", "operator.write"];
  expectStarted(await fixture.send(undefined, {}));
  fixture.client.connect.scopes = ["operator.admin"];
  expectStarted(
    await fixture.send(
      undefined,
      {},
      {
        ...fixture.params,
        idempotencyKey: "independent-admin-input",
      },
    ),
  );
  entryLifetime.beginClose();
  const retained = await retireOriginalInputs(fixture);
  fixture.context.requestEntryLifetime = new GatewayRequestEntryLifetime();
  const dispatchedScopes: string[][] = [];
  dispatchInboundMessageMock.mockImplementation(async (input) => {
    const authority = input.replyOptions?.operatorAuthority;
    expect(authority).toBeDefined();
    authority?.assertCurrent();
    dispatchedScopes.push([...(authority?.scopes ?? [])]);
    await input.replyOptions?.userTurnTranscriptRecorder?.persistApproved();
    return {};
  });
  await continueSessionQueuedInputs(fixture.context, retained.target, retained);
  await fixture.finishDispatch();
  expect(dispatchedScopes).toEqual([["operator.read", "operator.write"], ["operator.admin"]]);
});

it.each([
  new GatewayOperatorAccessUnavailableError(),
  new GatewayDispatchUnavailableError("chat.send", true),
])(
  "keeps accepted FIFO rows queued when restart admission is temporarily unavailable: %s",
  async (error) => {
    const created = await createFixture();
    await using fixture = created.fixture;
    expectStarted(await fixture.send());
    expectStarted(
      await fixture.send(undefined, {}, { ...fixture.params, idempotencyKey: "later-fifo-input" }),
    );
    const retained = await retireOriginalInputs(fixture);
    const restore = vi
      .spyOn(operatorRecovery, "restoreGatewayQueuedOperatorRecovery")
      .mockRejectedValueOnce(error);
    try {
      await continueSessionQueuedInputs(fixture.context, retained.target, retained);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect((await listSessionPendingInputs(fixture.scope)).items).toMatchObject([
        { state: "queued" },
        { state: "queued" },
      ]);
    } finally {
      restore.mockRestore();
    }
  },
);

it.each([
  new GatewayOperatorAccessUnavailableError(),
  new GatewayDispatchUnavailableError("chat.send", true),
])("keeps deferred restart input ahead of a fresh send: %s", async (error) => {
  const created = await createFixture();
  await using fixture = created.fixture;
  fixture.params.message = "OLDER_RESTART_INPUT";
  expectStarted(await fixture.send());
  const retained = await retireOriginalInputs(fixture);
  await patchSessionEntryCore(retained.target, () => ({
    resumeAfterRestart: undefined,
    lifecycleRunId: undefined,
    status: "done",
  }));
  setRuntimeConfigSnapshot({
    ...getRuntimeConfig(),
    session: { store: fixture.scope.storePath },
  });
  const lifetime = new AbortController();
  fixture.context.agentDatabaseStartup = createAgentDatabaseStartupObservation(
    new Map(),
    lifetime.signal,
  );
  let unavailable = true;
  const restoreSource = operatorRecovery.restoreGatewayQueuedOperatorRecovery;
  using restore = vi
    .spyOn(operatorRecovery, "restoreGatewayQueuedOperatorRecovery")
    .mockImplementation((params) => {
      if (unavailable) {
        return Promise.reject(error);
      }
      return restoreSource(params);
    });
  const dispatched: string[] = [];
  dispatchInboundMessageMock.mockImplementation(async (input) => {
    const body = input.ctx.RawBody ?? input.ctx.Body ?? "";
    dispatched.push(body.includes("OLDER_RESTART_INPUT") ? "older" : "fresh");
    await input.replyOptions?.userTurnTranscriptRecorder?.persistApproved();
    return {};
  });
  try {
    await resumeMarkedSessions({
      context: fixture.context,
      signal: lifetime.signal,
      log: fixture.context.logGateway,
    });
    expect(dispatched).toEqual([]);
    const fresh = {
      ...fixture.params,
      message: "FRESH_INPUT",
      idempotencyKey: "fresh-after-restart",
    };
    await expect(fixture.send(undefined, {}, fresh)).rejects.toBe(error);
    expect(dispatched).toEqual([]);
    expect((await listSessionPendingInputs(fixture.scope)).items).toMatchObject([
      { state: "queued" },
    ]);
    unavailable = false;
    expectStarted(await fixture.send(undefined, {}, fresh));
    await fixture.finishDispatch();
    expect(dispatched).toEqual(["older", "fresh"]);
    expect(restore).toHaveBeenCalledTimes(3);
    expect((await listSessionPendingInputs(fixture.scope)).items).toEqual([]);
    expect(fixture.context.agentDatabaseStartup.hasPendingAgents).toBe(false);
  } finally {
    lifetime.abort();
    fixture.context.agentDatabaseStartup = undefined;
  }
});

it("retries relinquished startup input after a post-staging authority outage exactly once", async () => {
  const created = await createFixture();
  await using fixture = created.fixture;
  expectStarted(await fixture.send());
  const retained = await retireOriginalInputs(fixture);
  const outage = new GatewayOperatorAccessUnavailableError();
  using authority = vi
    .spyOn(dashboardAuthority, "createChatSendDashboardAuthority")
    .mockRejectedValueOnce(outage);
  dispatchInboundMessageMock.mockImplementation(async (input) => {
    await input.replyOptions?.userTurnTranscriptRecorder?.persistApproved();
    return {};
  });

  const deferred = expectDefined(
    await continueSessionQueuedInputs(fixture.context, retained.target, retained),
    "deferred startup replay",
  );
  expect(deferred.error).toMatchObject({ message: outage.message });
  expect(authority).toHaveBeenCalledOnce();
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  expect((await readSessionQueuedInputPage(retained.target)).rows).toMatchObject([
    {
      input_id: retained.queuedInputIds[0],
      run_id: fixture.params.idempotencyKey,
      state: "queued",
      lifecycle_generation: getAgentEventLifecycleGeneration(),
    },
  ]);

  await deferred.resume();
  await fixture.finishDispatch();
  expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
  expect((await listSessionPendingInputs(fixture.scope)).items).toEqual([]);
  await deferred.resume();
  await fixture.finishDispatch();
  expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
});

it.each(["allowed", "missing source", "different sender", "revoked device"] as const)(
  "readmits queued input through its original requester source: %s",
  async (change) => {
    const created = await createFixture();
    await using fixture = created.fixture;
    expectStarted(await fixture.send());
    const retained = await retireOriginalInputs(fixture);
    const inputId = retained.queuedInputIds[0]!;
    if (change === "revoked device") {
      persistDevices(resolveStateDir(), [], "both");
    }
    const database = openOpenClawAgentDatabase({
      agentId: fixture.scope.agentId,
      path: retained.target.storePath,
    });
    if (change === "missing source") {
      database.db
        .prepare("UPDATE session_pending_inputs SET origin_source_json = NULL WHERE input_id = ?")
        .run(inputId);
    } else if (change === "different sender") {
      const [row] = (await readSessionQueuedInputPage(retained.target)).rows;
      const source = decodeQueuedOperatorRecoverySource(JSON.parse(row!.origin_source_json!));
      if (source.kind !== "gateway") {
        throw new Error("Expected a durable Gateway operator source");
      }
      const other = ensureProfileForEmail("different-queued-author@example.test");
      database.db
        .prepare("UPDATE session_pending_inputs SET origin_source_json = ? WHERE input_id = ?")
        .run(
          JSON.stringify({ ...source, snapshot: { ...source.snapshot, profileId: other.id } }),
          inputId,
        );
    }
    if (change === "revoked device") {
      expect(
        database.db
          .prepare("SELECT origin_source_json FROM session_pending_inputs WHERE input_id = ?")
          .get(inputId)?.origin_source_json,
      ).toEqual(expect.any(String));
    }
    await continueSessionQueuedInputs(fixture.context, retained.target, retained);
    await fixture.finishDispatch();
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(change === "allowed" ? 1 : 0);
    if (change === "allowed") {
      return;
    }
    expect((await listSessionPendingInputs(fixture.scope)).items).toMatchObject([
      {
        id: inputId,
        state: "cancelled",
        ...(change === "missing source" ? { endCause: "restart-unrecoverable" } : {}),
        ...(change === "revoked device" ? { endCause: "revoked" } : {}),
      },
    ]);
    expect(
      database.db
        .prepare("SELECT origin_source_json FROM session_pending_inputs WHERE input_id = ?")
        .get(inputId)?.origin_source_json,
    ).toBeNull();
    expect(fixture.context.logGateway.warn).toHaveBeenCalledWith(
      expect.stringContaining("was not sent after restart"),
    );
  },
);

it.each(["original route", "writer"] as const)(
  "readmits accepted reply and runtime intent under current route permissions: %s",
  async (mode) => {
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
    const accepted = (await listSessionPendingInputs(fixture.scope)).items;
    expect(accepted).toHaveLength(1);
    const retained = await retireOriginalInputs(fixture);
    const dispatched: DispatchedInput[] = [];
    dispatchInboundMessageMock.mockImplementation(async (input) => {
      dispatched.push(input);
      expect(getRequesterProfile(input.ctx)?.id).toBe(profile.id);
      await input.replyOptions?.userTurnTranscriptRecorder?.persistApproved();
      return {};
    });
    vi.mocked(fixture.context.logGateway.warn).mockClear();
    if (mode !== "original route") {
      setUserProfileRole(profile.id, "writer");
    }
    await continueSessionQueuedInputs(fixture.context, retained.target, retained);
    await fixture.finishDispatch();
    if (mode === "writer") {
      expect(dispatched).toEqual([]);
      expect(fixture.context.logGateway.warn).toHaveBeenCalledWith(
        expect.stringContaining("originating route fields require admin scope"),
      );
      expect((await listSessionPendingInputs(fixture.scope)).items).toMatchObject([
        { id: accepted[0]!.id, state: "cancelled" },
      ]);
      return;
    }
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
    expect(dispatched[0]?.replyOptions?.operatorAuthority?.scopes.toSorted()).toEqual([
      "operator.admin",
      "operator.read",
      "operator.write",
    ]);
  },
);

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
