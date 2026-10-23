import { createServer } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "../../config/sessions/session-accessor.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runSessionMutation } from "../../sessions/session-controller.lifecycle.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import { dispatchReplyFromConfig } from "./dispatch-from-config.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

const sessionKey = "agent:main:proof-delivery-reset";
const sessionId = "proof-original-session";
const text = "Accepted reply must survive its reset boundary.";

describe("accepted dispatch reply transcript custody", () => {
  const fixture = useTempSessionsFixture("dispatch-transcript-reset-");

  it.for([false, true])("records the accepted reply before reset=%s", async (reset, { signal }) => {
    const storePath = fixture.storePath();
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: { main: {} },
        defaults: { workspace: path.dirname(storePath) },
      },
      session: { store: storePath },
      plugins: { enabled: false },
      messages: { visibleReplies: "automatic" },
    };
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId,
        updatedAt: Date.now(),
        lifecycleRevision: "before-reset",
        activeWriterRunId: "proof-run",
      },
    );
    const accepted = createDeferred();
    const releaseReceipt = createDeferred();
    const mutationPrepared = createDeferred();
    const requests: string[] = [];
    const order: string[] = [];
    const receiver = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) {
              chunks.push(Buffer.from(chunk));
            }
            requests.push(Buffer.concat(chunks).toString("utf8"));
            order.push("transport-accepted");
            accepted.resolve();
            await releaseReceipt.promise;
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ messageId: "receipt-134498" }));
          })().catch((error: unknown) => {
            accepted.reject(error);
            response.destroy(error instanceof Error ? error : new Error(String(error)));
          });
        }),
    });
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        const response = await fetch(`http://127.0.0.1:${receiver.claim.port}/reply`, {
          method: "POST",
          body: payload.text,
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ messageId: "receipt-134498" });
        order.push("transport-receipt");
        return { visibleReplySent: true };
      },
    });
    const dispatch = withReplyDispatcher({
      dispatcher,
      run: () =>
        dispatchReplyFromConfig({
          cfg,
          dispatcher,
          ctx: {
            AgentId: "main",
            Body: "Return the accepted reply.",
            CommandAuthorized: true,
            Provider: "webchat",
            Surface: "webchat",
            ChatType: "direct",
            From: "proof-user",
            To: "proof-user",
            SessionKey: sessionKey,
            MessageSid: `proof-input-${reset}`,
            InboundAccessAuthorized: true,
          },
          replyOptions: { runId: "proof-run", abortSignal: signal },
          replyResolver: async () => {
            return setReplyPayloadMetadata(
              { text },
              {
                sourceReplyTranscriptMirror: {
                  sessionKey,
                  agentId: "main",
                  expectedSessionId: sessionId,
                  idempotencyKey: "proof-accepted-reply",
                  text,
                },
              },
            );
          },
        }),
    });
    let mutation: Promise<unknown> | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          accepted.promise,
          dispatch,
          "Dispatch completed before transport acceptance",
        ),
        signal,
      );
      if (reset) {
        mutation = runSessionMutation({
          scope: storePath,
          agentId: "main",
          identities: [sessionKey, sessionId],
          kind: "reset",
          policy: "preempt",
          signal,
          preempt: { activeRun: "abort", waitingInputs: "cancel" },
          prepare: async () => {
            mutationPrepared.resolve();
          },
          run: async () => {
            order.push("reset-entered");
            await resetSessionEntryLifecycle({
              agentId: "main",
              storePath,
              target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
              resetBoundary: { context: "clear", reason: "new", cwd: path.dirname(storePath) },
              archivePreviousTranscript: false,
              buildNextEntry: () => ({
                sessionId,
                updatedAt: Date.now(),
                lifecycleRevision: "after-reset",
              }),
            });
            order.push("reset-committed");
          },
        });
        await withinTest(
          awaitGateBeforeSettlement(
            mutationPrepared.promise,
            mutation,
            "Reset completed before preparation",
          ),
          signal,
        );
      }
      releaseReceipt.resolve();
      await dispatch;
      await mutation;
      const events = await loadTranscriptEvents({
        agentId: "main",
        sessionKey,
        sessionId,
        storePath,
      });
      const replies = events.filter((event) => JSON.stringify(event).includes(text));
      expect(requests).toEqual([text]);
      expect(replies).toHaveLength(1);
      if (reset) {
        const replyIndex = events.indexOf(replies[0]);
        const resetIndex = events.findIndex((event) => isRecord(event) && event.type === "reset");
        expect(resetIndex).toBeGreaterThan(replyIndex);
        expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
          sessionId,
          lifecycleRevision: "after-reset",
        });
        expect(order).toEqual([
          "transport-accepted",
          "transport-receipt",
          "reset-entered",
          "reset-committed",
        ]);
      }
    } finally {
      releaseReceipt.resolve();
      await Promise.allSettled([dispatch, mutation]);
      await receiver.releaseListener();
      await receiver.claim.release();
    }
  });
});
