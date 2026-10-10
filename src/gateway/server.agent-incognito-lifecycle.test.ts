import "./test-helpers.mocks.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import { initializeGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { PluginHookRegistration } from "../plugins/hook-types.js";
import type { PluginHookEndedTranscriptReadResult } from "../plugins/session-end-transcript.js";
import { closeSkillsWatchers } from "../skills/runtime/refresh.js";
import { openIncognitoTestActor } from "../state/openclaw-agent-execution-incognito.test-support.js";
import { dispatchGatewayRequestInProcessRaw } from "./server-in-process-dispatch.js";
import * as patchBuilder from "./server-methods/agent-session-patch.js";
import { createOperatorClient } from "./server-plugin-in-process-dispatch.test-support.js";
import {
  createResetDeliveryFixture,
  installAgentAuthorityProofFixture,
} from "./server.agent-runtime-authority-proof.test-support.js";
import * as resets from "./session-reset-service.js";
import { agentCommandMock } from "./test-helpers.js";
import { getTestPluginRegistry } from "./test-helpers.plugin-registry.js";

const authority = { assertCurrent() {} };
const key = (id: string) => `agent:main:dashboard:incognito-${id}`;
const operator = () =>
  createOperatorClient({ profileName: "incognito-lifecycle", scopes: ["operator.admin"] });

// These cases enter registered Gateway methods; only model inference is replaced.
describe("bound incognito agent lifecycle composition", () => {
  const fixture = installAgentAuthorityProofFixture();

  afterEach(async () => {
    await closeSkillsWatchers(true);
  });

  it.each([false, true])(
    "keeps private-parent group trust bounded with parent changed=%s",
    async (changed) => {
      const f = await fixture({ imageCapable: true });
      const actor = await openIncognitoTestActor(process.env, authority);
      const parentKey = key(randomUUID());
      const childKey = key(randomUUID());
      const group = { groupId: "private-group", groupChannel: "matrix", space: "private-space" };
      await actor.sessions.create(authority, {
        sessionKey: parentKey,
        entry: { sessionId: randomUUID(), updatedAt: Date.now(), incognito: true, ...group },
      });
      await actor.sessions.create(authority, {
        sessionKey: childKey,
        entry: {
          sessionId: randomUUID(),
          updatedAt: Date.now(),
          incognito: true,
          spawnedBy: parentKey,
        },
      });
      const childBefore = (await actor.sessions.read(authority, { sessionKey: childKey })).entry;
      agentCommandMock.mockResolvedValue({ payloads: [{ text: "done" }], meta: { durationMs: 1 } });
      const entered = createDeferred();
      const release = createDeferred();
      const original = patchBuilder.buildAgentSessionPatch;
      let held = false;
      const observer = vi
        .spyOn(patchBuilder, "buildAgentSessionPatch")
        .mockImplementation(async (params) => {
          const result = await original(params);
          if (!held) {
            held = true;
            entered.resolve();
            await release.promise;
          }
          return result;
        });
      let request: ReturnType<typeof dispatchGatewayRequestInProcessRaw> | undefined;
      const sql = observeHostDataSql();
      try {
        request = withIncognitoSessionActor(actor, () =>
          dispatchGatewayRequestInProcessRaw(
            "agent",
            { sessionKey: childKey, message: "continue child", idempotencyKey: randomUUID() },
            { client: operator(), context: f.context, expectFinal: true },
          ),
        );
        await awaitGateBeforeSettlement(
          entered.promise,
          request,
          "agent skipped parent preparation",
        );
        if (changed) {
          await withIncognitoSessionActor(actor, () =>
            patchSessionEntryCore(
              { agentId: actor.agentId, storePath: actor.path, sessionKey: parentKey },
              () => ({ groupId: "replaced-group" }),
            ),
          );
        }
        release.resolve();
        if (changed) {
          await expect(request).rejects.toThrow("Related session changed");
        } else {
          const response = await request;
          expect(response.ok, response.error?.message).toBe(true);
        }
        await f.drain();
        const child = (await actor.sessions.read(authority, { sessionKey: childKey })).entry;
        expect(child?.groupId).toBeUndefined();
        expect(child?.groupChannel).toBeUndefined();
        expect(child?.space).toBeUndefined();
        if (changed) {
          expect(child).toEqual(childBefore);
          expect(agentCommandMock).not.toHaveBeenCalled();
        } else {
          expect(agentCommandMock).toHaveBeenCalledOnce();
        }
        expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
      } finally {
        release.resolve();
        await Promise.allSettled(request ? [request] : []);
        sql.restore();
        observer.mockRestore();
        await f.cleanup();
        await actor.close();
      }
    },
  );

  it("delivers a bare reset failure once and replays it without repeating the reset", async () => {
    const { f, attempts, recordingAdapterRetained } = await createResetDeliveryFixture(fixture, {
      failSend: true,
    });
    const actor = await openIncognitoTestActor(process.env, authority);
    const sessionKey = key(randomUUID());
    await actor.sessions.create(authority, {
      sessionKey,
      entry: { sessionId: randomUUID(), updatedAt: Date.now(), incognito: true },
    });
    const reset = vi.spyOn(resets, "performGatewaySessionReset");
    const client = operator();
    const request = {
      sessionKey,
      idempotencyKey: randomUUID(),
      message: "/reset",
      deliver: true,
      bestEffortDeliver: false,
      channel: "matrix",
      to: "!proof:example.test",
    };
    const sql = observeHostDataSql();
    try {
      expect(recordingAdapterRetained).toBe(true);
      await withIncognitoSessionActor(actor, async () => {
        const invoke = () =>
          dispatchGatewayRequestInProcessRaw("agent", request, {
            client,
            context: f.context,
            expectFinal: true,
          });
        const response = await invoke();
        await f.drain();
        expect(response).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining("proof strict reset delivery failure") },
        });
        expect((await actor.sessions.read(authority, { sessionKey })).entry).toBeUndefined();
        expect(attempts()).toBe(1);
        const replay = await invoke();
        await f.drain();
        expect(replay).toMatchObject({ ok: false, meta: { cached: true }, error: response.error });
        expect(reset).toHaveBeenCalledOnce();
        expect(attempts()).toBe(1);
        expect((await actor.sessions.read(authority, { sessionKey })).entry).toBeUndefined();
      });
      expect(agentCommandMock).not.toHaveBeenCalled();
      expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
    } finally {
      sql.restore();
      reset.mockRestore();
      await f.cleanup();
      await actor.close();
    }
  });

  it.each(["reset", "delete"] as const)(
    "gives the ended hook the rotated window and refuses access after %s",
    async (removal) => {
      const f = await fixture({ imageCapable: true });
      const actor = await openIncognitoTestActor(process.env, authority);
      const sessionKey = key(randomUUID());
      const oldSessionId = randomUUID();
      const nextSessionId = randomUUID();
      await actor.sessions.create(authority, {
        sessionKey,
        entry: { sessionId: oldSessionId, updatedAt: Date.now(), incognito: true },
      });
      await withIncognitoSessionActor(actor, () =>
        appendTranscriptMessage(
          { agentId: "main", sessionKey, sessionId: oldSessionId, storePath: actor.path },
          { message: { role: "user", content: "closed private window", timestamp: Date.now() } },
        ),
      );
      const removalObserved = createDeferred();
      const observed: Array<{
        sessionId: string;
        tail?: PluginHookEndedTranscriptReadResult;
        unavailable?: unknown;
        error?: unknown;
      }> = [];
      const hook: PluginHookRegistration<"session_end"> = {
        pluginId: "incognito-ended-proof",
        hookName: "session_end",
        source: "test",
        conversationAccessAllowed: true,
        async handler(event, context) {
          if (context.sessionKey !== sessionKey) return;
          const item: (typeof observed)[number] = { sessionId: event.sessionId };
          observed.push(item);
          try {
            item.tail = context.endedTranscript?.available
              ? await context.endedTranscript.readTail({ maxMessages: 10, maxBytes: 4_096 })
              : undefined;
            if (!context.endedTranscript?.available) item.unavailable = context.endedTranscript;
          } catch (error) {
            item.error = error;
          }
          if (event.sessionId === nextSessionId) removalObserved.resolve();
        },
      };
      const registry = getTestPluginRegistry();
      const originalHooks = registry.typedHooks;
      registry.typedHooks = [...originalHooks, hook];
      initializeGlobalHookRunner(registry);
      const client = operator();
      agentCommandMock.mockImplementation(async (options) => {
        await options.userTurnTranscriptRecorder?.persistApproved();
        return { payloads: [{ text: "done" }], meta: { durationMs: 1 } };
      });
      const sql = observeHostDataSql();
      try {
        await withIncognitoSessionActor(actor, async () => {
          const response = await dispatchGatewayRequestInProcessRaw(
            "agent",
            {
              sessionKey,
              sessionId: nextSessionId,
              message: "new private window",
              idempotencyKey: randomUUID(),
            },
            { client, context: f.context, expectFinal: true },
          );
          await f.drain();
          expect(response, response.error?.message).toMatchObject({ ok: true });
          expect((await actor.sessions.read(authority, { sessionKey })).entry?.sessionId).toBe(
            nextSessionId,
          );
          expect(observed).toEqual([
            {
              sessionId: oldSessionId,
              tail: {
                messages: [expect.objectContaining({ content: "closed private window" })],
                totalMessages: 1,
                truncated: false,
              },
            },
          ]);
          const removed = await dispatchGatewayRequestInProcessRaw(
            removal === "reset" ? "sessions.reset" : "sessions.delete",
            { key: sessionKey },
            { client, context: f.context, expectFinal: true },
          );
          expect(removed, removed.error?.message).toMatchObject({ ok: true });
          await removalObserved.promise;
          await f.drain();
          expect((await actor.sessions.read(authority, { sessionKey })).entry).toBeUndefined();
          expect(observed.at(-1)).toMatchObject({
            sessionId: nextSessionId,
            unavailable: {
              available: false,
              reason: removal === "reset" ? "incognito-deleted" : "archive-unavailable",
            },
          });
          expect(observed.some((item) => item.error !== undefined)).toBe(false);
        });
        expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
      } finally {
        sql.restore();
        registry.typedHooks = originalHooks;
        initializeGlobalHookRunner(registry);
        await f.cleanup();
        await actor.close();
      }
    },
  );
});
