import { Agent, fetch } from "undici";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { withInvitedGuestGateway } from "./guest-session-access.test-support.js";
import * as sessionHistoryState from "./session-history-state.js";
import {
  appendHistoryMessage,
  historyStream,
  historyTexts,
  type SessionHistoryBody,
} from "./sessions-history-http-read.test-support.js";

it("rechecks invited membership before HTTP history JSON and live SSE publication", async ({
  signal,
}) => {
  await withInvitedGuestGateway(signal, async ({ gateway, sender, carol, headers, origin }) => {
    const { key } = await sender.request<{ key: string }>(
      "sessions.create",
      { agentId: "main", visibility: "shared" },
      { signal },
    );
    const sessionId = loadSessionEntry({ agentId: "main", sessionKey: key })!.sessionId;
    const membership = (method: "add" | "remove") =>
      sender.request(
        `session.members.${method}`,
        { agentId: "main", sessionKey: key, identityId: carol.id },
        { signal },
      );
    const append = (text: string) =>
      appendHistoryMessage({
        agentId: "main",
        sessionKey: key,
        expectedSessionId: sessionId,
        message: makeAgentAssistantMessage({
          content: [{ type: "text", text }],
          model: "gpt-5.5",
          timestamp: Date.now(),
        }),
        updateMode: "inline",
      });
    await append("private history seed");
    await membership("add");
    // The isolated loopback fixture uses a static self-signed test certificate.
    const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    try {
      const requestHistory = (identity: "bob" | "carol", stream = false) => {
        const init = {
          dispatcher,
          signal,
          headers: {
            ...headers(`${identity}@committed-mention.example.test`),
            origin,
            "x-openclaw-scopes": identity === "bob" ? "operator.sessions.read" : "operator.read",
            accept: stream ? "text/event-stream" : "application/json",
          },
        };
        return fetch(
          `https://127.0.0.1:${gateway.port}/sessions/${encodeURIComponent(key)}/history`,
          init,
        );
      };
      const expectMissing = async (response: Awaited<ReturnType<typeof fetch>>) => {
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
          ok: false,
          error: { type: "not_found", message: `Session not found: ${key}` },
        });
      };
      await expectMissing(await requestHistory("bob"));
      const allowed = await requestHistory("carol");
      expect(allowed.status).toBe(200);
      const body = (await allowed.json()) as SessionHistoryBody;
      expect(historyTexts(body)).toEqual(["private history seed"]);
      {
        const entered = createDeferred();
        const release = createDeferred();
        const readSnapshot = sessionHistoryState.readSessionHistorySnapshotAsync;
        using _ = vi
          .spyOn(sessionHistoryState, "readSessionHistorySnapshotAsync")
          .mockImplementationOnce(async (params) => {
            const snapshot = await readSnapshot(params);
            expect(params.target.sessionKey).toBe(key);
            entered.resolve();
            await release.promise;
            return snapshot;
          });
        const pending = requestHistory("carol");
        void pending.catch(() => {});
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              entered.promise,
              pending,
              "HTTP response skipped snapshot preparation",
            ),
            signal,
          );
          await membership("remove");
          release.resolve();
          await expectMissing(await pending);
        } finally {
          release.resolve();
          await Promise.allSettled([pending]);
        }
      }
      await membership("add");
      // No limit or cursor: exercise the inline SSE publication owner.
      await using stream = historyStream(await requestHistory("carol", true));
      await withinTest(stream.expectTexts(["private history seed"]), signal);
      const visible = await append("visible live update");
      await withinTest(stream.expectMessage("visible live update", 2, visible.messageId), signal);
      const entered = createDeferred();
      const release = createDeferred();
      const prototype = sessionHistoryState.SessionHistorySseState.prototype;
      // oxlint-disable-next-line typescript/unbound-method -- apply preserves the intercepted SSE owner.
      const prepareInline = prototype.prepareInlineMessage;
      using cleanup = new DisposableStack();
      cleanup.use(
        vi.spyOn(prototype, "prepareInlineMessage").mockImplementationOnce(async function (
          this: sessionHistoryState.SessionHistorySseState,
          update,
        ) {
          const prepared = await prepareInline.call(this, update);
          expect(update.message).toMatchObject({
            content: [{ type: "text", text: "private pending update" }],
          });
          entered.resolve();
          await release.promise;
          return prepared;
        }),
      );
      const next = stream.next("message");
      void next.catch(() => {});
      try {
        await append("private pending update");
        await withinTest(
          awaitGateBeforeSettlement(
            entered.promise,
            next,
            "SSE delivered an event before inline preparation was held",
          ),
          signal,
        );
        await membership("remove");
        release.resolve();
        await expect(withinTest(next, signal)).rejects.toThrow(
          "SSE stream ended before next event",
        );
        await expectMissing(await requestHistory("carol"));
      } finally {
        release.resolve();
        await stream.reader.cancel();
        await Promise.allSettled([next]);
      }
    } finally {
      await dispatcher.destroy();
    }
  });
});
