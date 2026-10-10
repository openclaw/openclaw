import "../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { ReplyBackendMessageInjectionV2 } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import {
  createReplyOperation,
  replyRunRegistry,
} from "../../auto-reply/reply/reply-run-registry.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import {
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "../../config/sessions/session-incognito-binding.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  openIncognitoTestActor,
  useIncognitoNoHostSql,
} from "../../state/openclaw-agent-execution-incognito.test-support.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import type { GatewayRecoveryRuntime } from "../server-instance-runtime.types.js";
import { createOperatorClient } from "../server-plugin-in-process-dispatch.test-support.js";
import { prepareChatMetadataSessionRead } from "./chat-metadata-session-read.js";
import * as activeLeaf from "./chat-send-active-leaf.js";
import { handleChatSend } from "./chat-send-handler.js";
import { createActiveRun } from "./chat.abort.test-helpers.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const authority = { assertCurrent() {} };
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let actor: Awaited<ReturnType<typeof openIncognitoTestActor>>;
let client: ReturnType<typeof createOperatorClient>;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", label: "chat-incognito-admission" });
  setRuntimeConfigSnapshot({});
  client = createOperatorClient({
    profileName: "incognito-operator",
    scopes: ["operator.admin"],
  });
  actor = await openIncognitoTestActor(state.env, authority);
});
afterAll(async () => {
  await actor?.close();
  await state?.cleanup();
});
useIncognitoNoHostSql();

async function create(name: string, fields: Partial<SessionEntry> = {}) {
  const sessionKey = `agent:main:dashboard:incognito-${name}`;
  const result = await actor.sessions.create(authority, {
    sessionKey,
    entry: { sessionId: name, updatedAt: Date.now(), incognito: true, ...fields },
  });
  assert(result.entry);
  return { canonicalKey: sessionKey, entry: result.entry, storePath: actor.path };
}

function send(
  session: Awaited<ReturnType<typeof create>>,
  context: GatewayRequestContext,
  message: string,
  idempotencyKey: string,
  extra: Record<string, unknown> = {},
) {
  const respond = vi.fn<RespondFn>();
  const pending = handleChatSend({
    req: { type: "req", id: idempotencyKey, method: "chat.send" },
    params: { sessionKey: session.canonicalKey, message, idempotencyKey, ...extra },
    respond,
    client,
    context,
    isWebchatConnect: () => false,
  });
  return { pending, respond };
}

it.each(["unchanged", "append", "rotation"] as const)(
  "chat.send stops only its retained active leaf after %s during preparation",
  async (change) => {
    const session = await create(`stop-${change}`);
    const context = createDirectChatContext({ getRuntimeConfig: () => ({}) });
    const runId = `active-${change}`;
    const active = createActiveRun(session.canonicalKey, {
      sessionId: session.entry.sessionId,
      agentId: "main",
    });
    context.chatAbortControllers.set(runId, active);
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    const prepare = activeLeaf.prepareExpectedLeafActive;
    const spy = vi
      .spyOn(activeLeaf, "prepareExpectedLeafActive")
      .mockImplementationOnce(async (...args) => {
        const assertLeaf = await prepare(...args);
        entered.resolve();
        await resume.promise;
        return assertLeaf;
      });
    await withIncognitoSessionActor(actor, async () => {
      const request = send(session, context, "/stop", `stop-${change}`, {
        expectedLeafEntryId: null,
        sessionId: session.entry.sessionId,
      });
      try {
        await awaitGateBeforeSettlement(entered.promise, request.pending, "stop leaf preparation");
        expect(active.controller.signal.aborted).toBe(false);
        expect(request.respond).not.toHaveBeenCalled();
        if (change === "append") {
          await actor.sessions.transcript(authority, {
            type: "session.message.append",
            input: {
              sessionKey: session.canonicalKey,
              sessionId: session.entry.sessionId,
              message: { role: "user", content: "new branch input", timestamp: 1 },
            },
          });
        } else if (change === "rotation") {
          const rotated = await actor.sessions.transcript(authority, {
            type: "session.manager.transcript.branch",
            input: {
              sessionKey: session.canonicalKey,
              command: {
                type: "session.transcript.branch",
                input: {
                  scope: {
                    agentId: "main",
                    storePath: actor.path,
                    sessionKey: session.canonicalKey,
                    sessionId: session.entry.sessionId,
                  },
                  branch: { sessionId: "stop-successor", events: [] },
                  expectedLifecycleRevision: session.entry.lifecycleRevision,
                },
              },
            },
          });
          assert(rotated.ok);
        }
        resume.resolve();
        await request.pending;
        if (change === "unchanged") {
          expect(active.controller.signal.aborted).toBe(true);
          expect(request.respond).toHaveBeenCalledWith(true, {
            ok: true,
            aborted: true,
            runIds: [runId],
          });
        } else {
          expect(active.controller.signal.aborted).toBe(false);
          expect(context.chatAbortControllers.get(runId)).toBe(active);
          expect(request.respond).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({
              code: "INVALID_REQUEST",
              ...(change === "append"
                ? { details: { reason: "active-leaf-changed" } }
                : { message: expect.stringContaining("generation is no longer current") }),
            }),
          );
        }
      } finally {
        resume.resolve();
        await Promise.allSettled([request.pending]);
        spy.mockRestore();
        context.chatAbortControllers.clear();
      }
    });
  },
);

it("retains metadata authority through an awaited provider preparation", async () => {
  const session = await create("metadata", { modelOverride: "first" });
  await withIncognitoSessionActor(actor, async () => {
    const prepared = await prepareChatMetadataSessionRead({
      cfg: {},
      agentId: "main",
      sessionKey: session.canonicalKey,
      assertRequestCurrent() {},
    });
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    const reading = prepared.withCurrent(async () => {
      entered.resolve();
      await resume.promise;
    });
    try {
      await awaitGateBeforeSettlement(entered.promise, reading, "metadata preparation");
      await patchSessionEntryCore(
        { agentId: "main", storePath: actor.path, sessionKey: session.canonicalKey },
        () => ({ modelOverride: "second" }),
      );
      resume.resolve();
      await expect(reading).rejects.toThrow("Session changed");
      expect(prepared.beforeRequest).toThrow("Session changed");
    } finally {
      resume.resolve();
      await Promise.allSettled([reading]);
      prepared.release();
    }
  });
});

it.each(["unchanged", "rotation"] as const)(
  "chat.send retains its private steering target after %s during preparation",
  async (change) => {
    const session = await create(`steer-${change}`, { displayName: "Existing private chat" });
    const runId = `steer-input-${change}`;
    const activeRunId = `steer-active-${change}`;
    const message = "Steer private reply";
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    const settled = createDeferred<void>();
    const context = createDirectChatContext({
      getRuntimeConfig: () => ({}),
      removeChatRun: vi.fn(() => settled.resolve()),
    });
    await withIncognitoSessionActor(actor, async () => {
      const operation = createReplyOperation({
        sessionKey: session.canonicalKey,
        sessionId: session.entry.sessionId,
        resetTriggered: false,
      });
      operation.bindToolAuthoritySnapshot({
        fingerprint: () => "private-steering-authority",
        project: () => "private-steering-authority",
        projectAsync: async () => {
          entered.resolve();
          await resume.promise;
          return "private-steering-authority";
        },
      });
      operation.bindToolAuthorityRoute({ provider: "test", model: "test" });
      const queueMessage = vi.fn<ReplyBackendMessageInjectionV2["queueMessage"]>(
        async (_text, _options, assertCurrent) => assertCurrent(),
      );
      operation.attachBackend({
        kind: "embedded",
        runId: activeRunId,
        toolAuthorityFingerprint: "private-steering-authority",
        cancel() {},
        messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage },
      });
      operation.setPhase("running");
      replyRunRegistry.bindSourceTurnId(operation, `source-${change}`);
      const request = send(session, context, message, runId, { queueMode: "steer" });
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          request.pending.then(() => {
            throw new Error(
              `chat.send ended before steering preparation: ${JSON.stringify(request.respond.mock.calls)}`,
            );
          }),
          "private steer preparation",
        );
        expect(queueMessage).not.toHaveBeenCalled();
        expect(request.respond).not.toHaveBeenCalled();
        if (change === "rotation") {
          const rotated = await actor.sessions.transcript(authority, {
            type: "session.manager.transcript.branch",
            input: {
              sessionKey: session.canonicalKey,
              command: {
                type: "session.transcript.branch",
                input: {
                  scope: {
                    agentId: "main",
                    storePath: actor.path,
                    sessionKey: session.canonicalKey,
                    sessionId: session.entry.sessionId,
                  },
                  branch: { sessionId: "steer-successor", events: [] },
                  expectedLifecycleRevision: session.entry.lifecycleRevision,
                },
              },
            },
          });
          assert(rotated.ok);
        }
        resume.resolve();
        await request.pending;
        await settled.promise;
        if (change === "unchanged") {
          expect(queueMessage).toHaveBeenCalledOnce();
          expect(queueMessage.mock.calls[0]?.[0]).toContain(message);
          expect(request.respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({ runId, status: "started" }),
            undefined,
            { runId },
          );
          expect(context.dedupe.get(`chat:${runId}`)).toMatchObject({
            ok: true,
            payload: { runId, status: "ok" },
          });
          const history = await actor.sessions.history(authority, {
            type: "session.history.hydrate",
            input: { sessionKey: session.canonicalKey, sessionId: session.entry.sessionId },
          });
          assert(history.kind === "full");
          expect(history.snapshot.events).toContainEqual(
            expect.objectContaining({
              type: "message",
              message: expect.objectContaining({
                role: "user",
                content: message,
                steerTargetRunId: activeRunId,
              }),
            }),
          );
        } else {
          expect(queueMessage).not.toHaveBeenCalled();
          expect(request.respond).toHaveBeenCalledWith(
            false,
            expect.objectContaining({ runId, status: "error" }),
            expect.objectContaining({
              message: expect.stringContaining("generation is no longer current"),
            }),
            expect.objectContaining({ runId }),
          );
          const successor = await actor.sessions.history(authority, {
            type: "session.history.hydrate",
            input: { sessionKey: session.canonicalKey, sessionId: "steer-successor" },
          });
          assert(successor.kind === "full");
          expect(successor.snapshot.events).not.toContainEqual(
            expect.objectContaining({
              type: "message",
              message: expect.objectContaining({ content: message }),
            }),
          );
        }
        expect(context.addChatRun).toHaveBeenCalledTimes(change === "unchanged" ? 1 : 0);
        expect(context.chatAbortControllers.size).toBe(0);
      } finally {
        resume.resolve();
        await Promise.allSettled([request.pending]);
        operation.complete();
      }
    });
  },
);

it.each(["settle", "actor-loss"] as const)(
  "chat.send joins same-process recovery before retry acknowledgement after %s",
  async (outcome) => {
    const clientRunId = `recovery-input-${outcome}`;
    const session = await create(`recovery-${outcome}`, {
      status: "interrupted",
      abortedLastRun: true,
      restartRecoverySourceIngress: "control-ui",
      restartRecoveryDeliveryRunId: `recovery-run-${outcome}`,
      restartRecoveryDeliverySourceRunId: clientRunId,
      pendingFinalDelivery: {
        kind: "replayable",
        text: "Already delivered",
        createdAt: Date.now(),
        intentId: `confirmed-intent-${outcome}`,
        deliveries: [{ id: `confirmed-delivery-${outcome}`, state: "delivered" }],
      },
    });
    const originalInput = await actor.sessions.transcript(authority, {
      type: "session.message.append",
      input: {
        sessionKey: session.canonicalKey,
        sessionId: session.entry.sessionId,
        message: {
          role: "user",
          content: "Original input",
          idempotencyKey: `${clientRunId}:user`,
          timestamp: Date.now(),
        },
      },
    });
    assert(originalInput.ok);
    const originalHistory = await actor.sessions.history(authority, {
      type: "session.history.hydrate",
      input: { sessionKey: session.canonicalKey, sessionId: session.entry.sessionId },
    });
    assert(originalHistory.kind === "full");
    const entered = createDeferred<void>();
    const resume = createDeferred<number | undefined>();
    const recoveryRuntime = {
      prepareRestartRecovery: vi.fn(() => {
        entered.resolve();
        return resume.promise;
      }),
      dispatchSessionMethod: vi.fn(async () => {
        throw new Error("Unexpected recovery dispatch");
      }),
      dispatchAgent: vi.fn(async () => {
        throw new Error("Unexpected agent dispatch");
      }),
      waitForAgent: vi.fn(async () => {
        throw new Error("Unexpected agent wait");
      }),
      sendRecoveryNotice: vi.fn(async () => {
        throw new Error("Unexpected recovery notice");
      }),
    } satisfies GatewayRecoveryRuntime;
    const context = createDirectChatContext({
      getRuntimeConfig: () => ({}),
      recoveryRuntime,
    });
    await withIncognitoSessionBinding({ actor }, async () => {
      const request = send(session, context, "Original input", clientRunId);
      let closing: Promise<void> | undefined;
      try {
        await awaitGateBeforeSettlement(entered.promise, request.pending, "recovery preparation");
        expect(request.respond).not.toHaveBeenCalled();
        if (outcome === "actor-loss") {
          closing = actor.close();
          expect(() => actor.assertReadable()).toThrow("Incognito session ended");
          resume.resolve(undefined);
          await expect(request.pending).rejects.toMatchObject({ code: "INCOGNITO_SESSION_ENDED" });
          await closing;
          const retry = send(session, context, "Original input", clientRunId);
          await expect(retry.pending).rejects.toMatchObject({ code: "INCOGNITO_SESSION_ENDED" });
          expect(retry.respond).not.toHaveBeenCalled();
        } else {
          resume.resolve(undefined);
          await request.pending;
          expect(request.respond).toHaveBeenCalledWith(
            true,
            { runId: clientRunId, status: "ok" },
            undefined,
            { cached: true, runId: clientRunId },
          );
          const settled = await actor.sessions.read(authority, {
            sessionKey: session.canonicalKey,
          });
          expect(settled.entry).toMatchObject({
            sessionId: session.entry.sessionId,
            status: "done",
            abortedLastRun: false,
            restartRecoveryTerminalRunIds: [clientRunId],
          });
          expect(settled.entry?.pendingFinalDelivery).toBeUndefined();
          expect(settled.entry?.restartRecoveryDeliveryRunId).toBeUndefined();
          const retry = send(session, context, "Original input", clientRunId);
          await retry.pending;
          expect(retry.respond.mock.calls).toEqual(request.respond.mock.calls);
          const history = await actor.sessions.history(authority, {
            type: "session.history.hydrate",
            input: { sessionKey: session.canonicalKey, sessionId: session.entry.sessionId },
          });
          assert(history.kind === "full");
          expect(history.snapshot.events).toEqual(originalHistory.snapshot.events);
        }
        expect(recoveryRuntime.prepareRestartRecovery).toHaveBeenCalledOnce();
        expect(recoveryRuntime.dispatchSessionMethod).not.toHaveBeenCalled();
        expect(recoveryRuntime.dispatchAgent).not.toHaveBeenCalled();
        expect(recoveryRuntime.waitForAgent).not.toHaveBeenCalled();
        expect(recoveryRuntime.sendRecoveryNotice).not.toHaveBeenCalled();
      } finally {
        resume.resolve(undefined);
        await Promise.allSettled([request.pending, closing]);
      }
    });
  },
);
