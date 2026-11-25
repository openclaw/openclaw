import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayClientInfo } from "../../../packages/gateway-protocol/src/client-info.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { seedCanonicalAcpSessionMeta } from "../../acp/runtime/session-meta-fixture.test-support.js";
import * as acpReads from "../../acp/runtime/session-meta-readonly.js";
import { getRuntimeConfig } from "../../config/config.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import {
  listSessionPendingInputs,
  loadSessionEntry,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import * as pendingInputs from "../../config/sessions/session-accessor.pending-inputs.js";
import type { SessionPendingInputReceipt } from "../../config/sessions/session-accessor.pending-inputs.js";
import { listLiveSessionPendingInputs } from "../../config/sessions/session-accessor.sqlite-pending-inputs.js";
import { prepareSqliteScope } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { readSessionQueuedInputPage } from "../../config/sessions/session-pending-input-history.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { GatewayOperatorAccessUnavailableError } from "../../infra/operator-authority-error.js";
import { captureCurrentReplyMessageInjectionTarget } from "../../sessions/session-controller.message-injection.js";
import { isSessionRunActiveForKey } from "../../sessions/session-controller.queries.js";
import {
  isRpcSourceActive,
  isRpcSourceQueued,
  requestRpcSourceCancellation,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { useUserProfileCatalogForTest } from "../../test-utils/user-profile-catalog.js";
import { refusePendingInputCommit } from "../pending-input-commit.test-support.js";
import { handleGatewayRequest } from "../server-methods.js";
import * as storeLookup from "../session-utils-store-lookup.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { registerChatCollectedInputReplayCases } from "./chat-send-collected-input-replay.test-support.js";
import { registerChatHistoryDeliveryCases } from "./chat-send-history-delivery.test-support.js";
import {
  setClientProfile,
  useBrowserFollowupFixture,
} from "./chat-send-pending-inputs.test-support.js";
import { createSessionMutationCatalog } from "./sessions-mutations.native-consent.test-support.js";
import type { RespondFn } from "./types.js";
installGatewayTestHooks();
const createBrowserFollowupFixture = useBrowserFollowupFixture();
const prepareProfileCatalog = useUserProfileCatalogForTest();
beforeEach(() => prepareProfileCatalog());

function expectStarted(respond: RespondFn, payload: Record<string, unknown> = {}) {
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ status: "started", ...payload }),
    undefined,
    expect.anything(),
  );
}

type FollowupFixture = Awaited<ReturnType<typeof createBrowserFollowupFixture>>;
const pending = (fixture: FollowupFixture) => listSessionPendingInputs(fixture.scope);
function expectNotStarted(respond: RespondFn) {
  expect(respond).toHaveBeenCalledOnce();
  expect(respond).not.toHaveBeenCalledWith(
    true,
    expect.objectContaining({ status: "started" }),
    undefined,
    expect.anything(),
  );
}
async function expectUncommitted(fixture: FollowupFixture) {
  expect(await pending(fixture)).toEqual({ items: [], total: 0 });
  expect(fixture.readTranscript()).toEqual(fixture.activeTranscript);
}
function expectInFlight(respond: RespondFn, runId: string) {
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ runId, status: "in_flight" }),
    undefined,
    expect.objectContaining({ cached: true }),
  );
}
function expectNoPlacementQueries(queries: string[]) {
  expect(queries.filter((query) => /\bworker_session_placements\b/u.test(query))).toEqual([]);
}
async function admitPending(fixture: FollowupFixture) {
  expectStarted(await fixture.send());
  const recorder = await fixture.dispatchedRecorder;
  const { items, total } = await pending(fixture);
  expect(total).toBe(1);
  expect(items[0]).toBeDefined();
  return { recorder, original: items[0] };
}

describe("ordinary chat input admission", () => {
  it("retains pending-input custody while retrying a transient post-ACK projection failure", async () => {
    await using fixture = await createBrowserFollowupFixture({ transientProjectionFailures: 1 });
    const ack = await fixture.send();
    expectStarted(ack);
    await vi.waitFor(() => expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2));
    const accepted = await pending(fixture);
    const reconnect = await fixture.send();
    expectInFlight(reconnect, fixture.params.idempotencyKey);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
    expect(await pending(fixture)).toMatchObject({
      total: 1,
      items: [{ state: "queued", runId: fixture.params.idempotencyKey }],
    });
    expect(await pending(fixture)).toEqual(accepted);
    expect(fixture.beforeApprove).toHaveBeenCalledOnce();
    expect(fixture.readTranscript()).toEqual(fixture.activeTranscript);
    expect(fixture.context.removeChatRun).not.toHaveBeenCalled();
    expect(fixture.context.broadcast).not.toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ runId: fixture.params.idempotencyKey, state: "error" }),
      expect.anything(),
    );
  });

  it("records a failed staged input after a pre-ACK authority outage without replaying it", async () => {
    await using fixture = await createBrowserFollowupFixture();
    const resolved = await prepareSqliteScope(fixture.scope);
    if (!resolved.path) {
      throw new Error("Expected the durable pending-input database path");
    }
    let unavailable = false;
    const outage = new GatewayOperatorAccessUnavailableError();
    const binding = {
      sessionMutationCommitGuard: () => {
        if (unavailable) {
          throw outage;
        }
      },
    };
    let receipt: SessionPendingInputReceipt | undefined;
    const stage = pendingInputs.stageSessionPendingInput;
    // Keep production admission, its source authority, and SQLite real. Only fail
    // the next authority check after staging has returned its committed receipt.
    using staging = vi.spyOn(pendingInputs, "stageSessionPendingInput");
    staging.mockImplementationOnce(async (...args) => {
      receipt = await stage(...args);
      unavailable = true;
      return receipt;
    });
    const rejected = await fixture.send(vi.fn(), binding);
    expect(rejected).toHaveBeenCalledOnce();
    expect(rejected).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ status: "error" }),
      expect.objectContaining({ code: "UNAVAILABLE", message: outage.message }),
      expect.anything(),
    );
    if (!receipt) {
      throw new Error("Expected chat.send to stage the input before the authority outage");
    }
    await receipt.settled?.();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(await pending(fixture)).toMatchObject({
      total: 1,
      items: [
        {
          id: receipt.inputId,
          state: "cancelled",
          endCause: "failed",
          runId: fixture.params.idempotencyKey,
          message: { content: fixture.approvedContent },
        },
      ],
    });
    expect(fixture.readTranscript()).toEqual(fixture.activeTranscript);
    expect(
      listLiveSessionPendingInputs(resolved.path, resolved.sessionKey, fixture.scope.sessionId),
    ).toEqual([]);
    expect(
      await sessionAccessor.readSessionSubmittedInput(
        fixture.scope,
        `${fixture.params.idempotencyKey}:user`,
        { includeSource: true },
      ),
    ).toMatchObject({ source: "pending", state: "cancelled", endCause: "failed" });
    expect((await readSessionQueuedInputPage(fixture.scope)).rows).toEqual([]);
    expect(rpcSourceTesting.has(fixture.params.idempotencyKey)).toBe(false);

    unavailable = false;
    const replay = await fixture.send(vi.fn(), binding);
    expect(replay).toHaveBeenCalledOnce();
    expect(replay).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        details: { reason: "chat-input-cancelled", endCause: "failed" },
      }),
    );
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(fixture.readTranscript()).toEqual(fixture.activeTranscript);
  });

  it.each([
    { id: "openclaw-control-ui", mode: "webchat", displayName: "Web", storage: "durable" },
    { id: "cli", mode: "cli", displayName: "CLI", storage: "durable" },
    { id: "openclaw-macos", mode: "ui", displayName: "macOS", storage: "durable" },
    { id: "gateway-client", mode: "backend", displayName: "Automation", storage: "durable" },
    { id: "openclaw-control-ui", mode: "webchat", displayName: "Web", storage: "memory" },
    {
      id: "openclaw-control-ui",
      mode: "webchat",
      displayName: "Web fallback",
      storage: "durable",
      autoFallback: true,
    },
  ] satisfies Array<
    Pick<GatewayClientInfo, "id" | "mode" | "displayName"> & {
      storage: "durable" | "memory";
      autoFallback?: boolean;
    }
  >)(
    "stages the approved $displayName $storage follow-up and its source before ACK without changing the active transcript",
    async ({ storage, autoFallback = false, ...clientInfo }) => {
      await using fixture = await createBrowserFollowupFixture({ storage });
      fixture.client.connect.client = { ...fixture.client.connect.client, ...clientInfo };
      fixture.params.queueMode = "followup";
      const profile = ensureProfileForEmail("alice@example.test");
      setClientProfile(fixture.client, { ...profile, updatedAt: 1 }, "Alice");
      await patchSessionEntryCore(fixture.scope, () => ({
        modelProvider: "openai",
        model: autoFallback ? "fallback-model" : "previous-model",
        providerOverride: "openai",
        modelOverride: autoFallback ? "fallback-model" : "previous-model",
        ...(autoFallback
          ? {
              modelOverrideSource: "auto" as const,
              modelOverrideFallbackOriginProvider: "openai",
              modelOverrideFallbackOriginModel: "selected-model",
              fallbackNotice: {
                kind: "active" as const,
                selectedModel: "openai/selected-model",
                activeModel: "openai/fallback-model",
                reason: "timeout",
              },
            }
          : {}),
      }));
      const selected = { provider: "openai", model: "selected-model" };
      if (!autoFallback) {
        fixture.context.loadGatewayModelCatalogSnapshot = async () =>
          createSessionMutationCatalog(
            getRuntimeConfig(),
            { agentDir: () => "/fixture/agent", workspaceDir: "/fixture/workspace" },
            ["previous-model", selected.model].map((id) => ({ provider: "openai", id, name: id })),
          );
        const patchResponse = vi.fn<RespondFn>();
        const patch = { key: fixture.scope.sessionKey, model: "openai/selected-model" };
        await handleGatewayRequest({
          req: { type: "req", id: "select-model", method: "sessions.patch", params: patch },
          client: fixture.client,
          context: fixture.context,
          isWebchatConnect: () => true,
          respond: patchResponse,
        });
        expect(patchResponse.mock.calls[0]?.[0]).toBe(true);
        expect(loadSessionEntry(fixture.scope)).not.toHaveProperty("model");
      }
      const modelSelection = {
        ...selected,
        previous: { provider: "openai", model: autoFallback ? "selected-model" : "previous-model" },
      };
      const clone = vi.spyOn(globalThis, "structuredClone");
      const { scope, params, context, approvedContent, activeTranscript } = fixture;
      const readPending = () =>
        Promise.allSettled([listSessionPendingInputs(scope)]).then(([result]) => result);
      let transcriptAtAck: ReturnType<typeof loadTranscriptEventsSync> | undefined;
      let pendingAtAck: ReturnType<typeof readPending> | undefined;
      let pendingAtNotification: ReturnType<typeof readPending> | undefined;
      context.getSessionEventSubscriberConnIds = () => new Set(["observer"]);
      vi.spyOn(context, "broadcastToConnIds").mockImplementation((event, payload) => {
        if (event === "sessions.changed" && isRecord(payload) && payload.reason === "send") {
          pendingAtNotification = readPending();
        }
      });
      const respond = vi.fn<RespondFn>((ok) => {
        if (ok) {
          transcriptAtAck = fixture.readTranscript();
          pendingAtAck = readPending();
        }
      });
      try {
        expect(isSessionRunActiveForKey(scope.sessionKey)).toBe(true);
        expect(captureCurrentReplyMessageInjectionTarget(scope.sessionKey)).toBeUndefined();
        await fixture.send(respond);
        expectStarted(respond, { runId: params.idempotencyKey });
        expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("messageSeq");
        expect(transcriptAtAck).toEqual(activeTranscript);
        const provenance = {
          senderIdentity: { type: "profile", id: profile.id },
          transport: { clients: [clientInfo] },
        };
        const expectedInput = {
          state: "queued",
          runId: params.idempotencyKey,
          message: {
            role: "user",
            content: approvedContent,
            idempotencyKey: `${params.idempotencyKey}:user`,
            __openclaw: { senderId: profile.id, ...provenance, modelSelection },
          },
        };
        expect(await pendingAtAck).toMatchObject({
          status: "fulfilled",
          value: { total: 1, items: [expectedInput] },
        });
        expect(await pendingAtNotification).toEqual(await pendingAtAck);
        const recorder = await fixture.dispatchedRecorder;
        expect(loadSessionEntry(scope)?.lastSubmittedModel).toEqual(
          autoFallback ? undefined : modelSelection.previous,
        );
        const committed = await recorder.persistApproved();
        expect(committed?.message["__openclaw"]).toMatchObject({ ...provenance, modelSelection });
        expect(loadSessionEntry(scope)?.lastSubmittedModel).toEqual(selected);
        // Initial resolution detaches the store; custody needs only the current target binding.
        expect(
          clone.mock.calls.filter(
            ([entry]) => isRecord(entry) && entry.sessionId === "unrelated-browser-session",
          ).length,
        ).toBeLessThanOrEqual(1);
      } finally {
        clone.mockRestore();
        await Promise.allSettled([pendingAtAck, pendingAtNotification]);
      }
    },
  );

  it("stamps a typed message with the model the session inherits from its parent", async () => {
    await using fixture = await createBrowserFollowupFixture({
      sessionKey: "agent:main:dashboard:inherit-child",
    });
    const parentKey = "agent:main:dashboard:inherit-parent";
    replaceSessionEntrySync(
      { ...fixture.scope, sessionKey: parentKey },
      {
        sessionId: "inherit-parent",
        updatedAt: Date.now(),
        providerOverride: "openai",
        modelOverride: "parent-pick",
        modelOverrideSource: "user",
        modelOverrideRouteResolution: "resolved",
      },
    );
    // No selection of its own: the session's turns run on the parent's pick.
    await patchSessionEntryCore(fixture.scope, () => ({ parentSessionKey: parentKey }));
    fixture.params.queueMode = "followup";

    expectStarted(await fixture.send());
    const recorder = await fixture.dispatchedRecorder;
    const committed = await recorder.persistApproved();

    const inherited = { provider: "openai", model: "parent-pick" };
    expect(committed?.message["__openclaw"]).toMatchObject({ modelSelection: inherited });
    expect(loadSessionEntry(fixture.scope)?.lastSubmittedModel).toEqual(inherited);
    expect(loadSessionEntry(fixture.scope)).not.toHaveProperty("modelOverride");
  });

  it("stops a session without reading the parent it inherits its model from", async () => {
    await using fixture = await createBrowserFollowupFixture({
      sessionKey: "agent:main:dashboard:inherit-child",
    });
    await patchSessionEntryCore(fixture.scope, () => ({
      parentSessionKey: "agent:main:dashboard:inherit-parent",
    }));
    const lookup = storeLookup.resolveGatewaySessionStoreTargetWithStoreAsync;
    using _ = vi
      .spyOn(storeLookup, "resolveGatewaySessionStoreTargetWithStoreAsync")
      .mockImplementation(async (params) => {
        if (params.key.includes("inherit-parent")) {
          throw new Error("parent session database unavailable");
        }
        return await lookup(params);
      });

    const respond = await fixture.send(vi.fn(), undefined, {
      ...fixture.params,
      message: "/stop",
      idempotencyKey: "stop-inheriting-child",
    });

    expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
      true,
      expect.objectContaining({ aborted: true }),
    ]);
  });

  it.each([{ acp: false }, { acp: true }, { acp: true, restart: true }])(
    "keeps idle input custody with its runtime (%j)",
    async ({ acp, restart }) => {
      await using fixture = await createBrowserFollowupFixture({ active: false });
      if (acp) {
        seedCanonicalAcpSessionMeta({
          sessionKey: fixture.scope.sessionKey,
          sessionId: fixture.scope.sessionId,
          meta: {
            backend: "acpx",
            agent: "main",
            runtimeSessionName: "idle-custody",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 1,
          },
        });
      }
      const clone = vi.spyOn(globalThis, "structuredClone");
      const sql = observeHostDataSql();
      const read = acpReads.readAcpSessionMetaForEntries;
      const restarting = restart
        ? vi
            .spyOn(acpReads, "readAcpSessionMetaForEntries")
            .mockImplementationOnce(async (...args) => {
              const result = await read(...args);
              rotateAgentEventLifecycleGeneration();
              return result;
            })
        : undefined;
      let transcriptAtAck: ReturnType<typeof loadTranscriptEventsSync> | undefined;
      const respond = vi.fn<RespondFn>((ok) => {
        if (ok) {
          transcriptAtAck = loadTranscriptEventsSync(fixture.scope);
        }
      });
      try {
        await fixture.send(respond);
        expectNoPlacementQueries(sql.queries);
        if (restart) {
          expectNotStarted(respond);
          expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
          await expectUncommitted(fixture);
          return;
        }
        expectStarted(respond, acp ? {} : { messageSeq: 2 });
        if (acp) {
          expect(transcriptAtAck).toEqual(fixture.activeTranscript);
          expect(await pending(fixture)).toMatchObject({ total: 1 });
          expect(loadSessionEntry(fixture.scope)).not.toHaveProperty("acp");
        } else {
          expect(transcriptAtAck).toHaveLength(fixture.activeTranscript.length + 1);
          expect(transcriptAtAck?.at(-1)).toMatchObject({
            message: {
              role: "user",
              content: fixture.params.message,
              idempotencyKey: `${fixture.params.idempotencyKey}:user`,
            },
          });
          expect(await pending(fixture)).toEqual({ items: [], total: 0 });
        }
        expect(
          clone.mock.calls.filter(
            ([entry]) => isRecord(entry) && entry.sessionId === "unrelated-browser-session",
          ).length,
        ).toBeLessThanOrEqual(1);
      } finally {
        sql.restore();
        restarting?.mockRestore();
        clone.mockRestore();
      }
    },
  );

  it.each(["worker-turn", "remote-exec"] as const)(
    "holds an idle %s browser input in custody while its workspace is syncing",
    async (executionMode) => {
      await using fixture = await createBrowserFollowupFixture({ active: false });
      const placements = createWorkerSessionPlacementStore();
      const requested = await placements.startDispatch({ ...fixture.scope, executionMode });
      const provisioning = await placements.transition({
        sessionId: fixture.scope.sessionId,
        from: "requested",
        to: "provisioning",
        expectedGeneration: requested.generation,
        patch: { environmentId: "setup-environment" },
      });
      await placements.transition({
        sessionId: fixture.scope.sessionId,
        from: "provisioning",
        to: "syncing",
        expectedGeneration: provisioning.generation,
        patch: { workerBundleHash: "a".repeat(64) },
      });
      fixture.context.workerSessionPlacementService = placements;
      const sql = observeHostDataSql();
      try {
        const respond = await fixture.send();
        expectNoPlacementQueries(sql.queries);
        expectStarted(respond);
        expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("messageSeq");
        expect(fixture.readTranscript()).toEqual(fixture.activeTranscript);
        expect(await pending(fixture)).toMatchObject({
          total: 1,
          items: [{ state: "queued", runId: fixture.params.idempotencyKey }],
        });
      } finally {
        sql.restore();
      }
    },
  );

  it("retries a failed custody write with the same request identity without acknowledging lost input", async () => {
    const fixture = await createBrowserFollowupFixture();
    let rejectedInput: RpcSourceRef["input"] | undefined;
    fixture.beforeApprove.mockImplementation(() => {
      rejectedInput = rpcSourceTesting.get(fixture.params.idempotencyKey)?.input;
    });
    const refusal = refusePendingInputCommit({
      operation: "stage",
      message: "custody unavailable",
      sessionId: fixture.scope.sessionId,
      runId: fixture.params.idempotencyKey,
    });

    try {
      const rejected = await fixture.send();
      expect(rejected).toHaveBeenCalledWith(
        false,
        expect.objectContaining({ status: "error" }),
        expect.objectContaining({ message: expect.stringContaining("custody unavailable") }),
        expect.anything(),
      );
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      await expectUncommitted(fixture);
      expect(rpcSourceTesting.has(fixture.params.idempotencyKey)).toBe(false);
      if (!rejectedInput) {
        throw new Error("Expected the rejected RPC source input");
      }
      await rejectedInput.settlement.promise;

      refusal.mockRestore();
      expectStarted(await fixture.send(), { runId: fixture.params.idempotencyKey });
      expect(await listSessionPendingInputs(fixture.scope)).toMatchObject({
        total: 1,
        items: [{ state: "queued", message: { content: fixture.approvedContent } }],
      });
      expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
    } finally {
      refusal.mockRestore();
      await fixture.cleanup();
    }
  });

  it.each(["cancellation", "lifecycle rotation", "session replacement"] as const)(
    "revalidates %s after message approval before committing custody",
    async (change) => {
      await using fixture = await createBrowserFollowupFixture();
      const baseline = { provider: "openai", model: "previous-model" };
      await patchSessionEntryCore(fixture.scope, () => ({ lastSubmittedModel: baseline }));
      fixture.beforeApprove.mockImplementation(() => {
        if (change === "lifecycle rotation") {
          rotateAgentEventLifecycleGeneration();
          return;
        }
        if (change === "session replacement") {
          replaceSessionEntrySync(fixture.scope, {
            sessionId: "successor-session",
            updatedAt: Date.now(),
          });
          return;
        }
        const active = rpcSourceTesting.get(fixture.params.idempotencyKey);
        if (!active) {
          throw new Error("Expected the browser admission to own its cancellation controller");
        }
        // Approval runs after asynchronous source preparation. Its cancellation
        // must hit the already reserved physical input, not an ACK-time facade.
        expect(active.input.mailbox.owner.target).toMatchObject({
          storeScope: fixture.scope.storePath,
          sessionKey: fixture.scope.sessionKey,
          incarnation: fixture.scope.sessionId,
        });
        expect(active.input.protocolRunId).toBe(fixture.params.idempotencyKey);
        expect(isRpcSourceActive(active)).toBe(false);
        expect(isRpcSourceQueued(active)).toBe(true);
        active.adapter.abortStopReason = "rpc";
        requestRpcSourceCancellation(active);
      });
      const respond = await fixture.send();
      expect(fixture.beforeApprove).toHaveBeenCalledOnce();
      expectNotStarted(respond);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      await expectUncommitted(fixture);
      if (change !== "session replacement") {
        expect(loadSessionEntry(fixture.scope)?.lastSubmittedModel).toEqual(baseline);
      }
      if (change === "session replacement") {
        expect(loadSessionEntry(fixture.scope)?.sessionId).toBe("successor-session");
        expect(
          loadTranscriptEventsSync({ ...fixture.scope, sessionId: "successor-session" }),
        ).toEqual([]);
      }
      expect(rpcSourceTesting.has(fixture.params.idempotencyKey)).toBe(false);
    },
  );

  registerChatCollectedInputReplayCases(createBrowserFollowupFixture, admitPending);

  it.for([
    { restart: true, attachment: false },
    { restart: true, attachment: true },
    { restart: false, attachment: false },
  ])(
    "rejects closed recorded input without dispatching again (%j)",
    async ({ restart, attachment }) => {
      await using fixture = await createBrowserFollowupFixture({ preserveContent: true });
      const profile = ensureProfileForEmail("restart-input@example.test");
      setClientProfile(fixture.client, { ...profile, updatedAt: 1 }, "Input author");
      if (restart && !attachment) {
        delete fixture.params.sessionId;
      }
      if (attachment) {
        fixture.params.attachments = [
          {
            type: "file",
            mimeType: "text/plain",
            fileName: "review.txt",
            content: Buffer.from("Keep these exact attachment bytes.").toString("base64"),
          },
        ];
      }
      try {
        const { recorder: originalRecorder, original } = await admitPending(fixture);
        if (restart) {
          rotateAgentEventLifecycleGeneration();
        } else {
          originalRecorder.finishPendingInput?.("cancelled", "failed");
          await originalRecorder.waitForPendingInputSettlement?.();
        }
        await fixture.finishDispatch();
        const endCause = restart ? "reset" : "failed";
        expect((await pending(fixture)).items).toEqual([
          { ...original, state: "cancelled", endCause },
        ]);
        expect(fixture.readTranscript()).toEqual(fixture.activeTranscript);
        fixture.context.dedupe.clear();
        await patchSessionEntryCore(fixture.scope, () => ({ status: "done" }));
        if (restart) {
          fixture.params.sessionId = fixture.scope.sessionId;
        }
        dispatchInboundMessageMock.mockClear();
        const ack = await fixture.send();
        expect(ack).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "INVALID_REQUEST",
            details: { reason: "chat-input-cancelled", endCause },
          }),
        );
        expect((await pending(fixture)).items).toEqual([
          { ...original, state: "cancelled", endCause },
        ]);
        if (restart) {
          expect(() => originalRecorder.withPendingInput?.(() => {})).toThrow("ownership ended");
        }
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        expect(fixture.readTranscript()).toEqual(fixture.activeTranscript);
        expect(fixture.beforeApprove).toHaveBeenCalledOnce();
      } finally {
        await fixture.finishDispatch();
      }
    },
  );

  registerChatHistoryDeliveryCases(createBrowserFollowupFixture);
});
