import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { persistColdLoadWarmState } from "../../../scripts/lib/control-ui-bench-warm-state.ts";
import type { ChatPaneElement } from "../pages/chat/chat-pane-elements.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  waitForControlUiGatewayReady,
  waitForControlUiInitialRoster,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createTeamScaleSidebarListOwner } from "../test-helpers/control-ui-sidebar-list-fixture.ts";
import { createControlUiTeamScaleFixture } from "../test-helpers/control-ui-team-scale-fixture.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Warm history subscription" });
const inventory = createControlUiTeamScaleFixture({ offRosterSession: true });
const sessionKey = inventory.selectedSessionKey;
const sessionId = sessionKey.slice(sessionKey.lastIndexOf(":") + 1);
const cursor = "cached-history-cursor";
const inventorySession = inventory.sidebarListInput.rows.find((row) => row.key === sessionKey);
if (!inventorySession) {
  throw new Error("Missing off-roster session inventory");
}
const session = {
  ...inventorySession,
  label: "Warm history",
  displayName: "Warm history",
  updatedAt: 1,
  activeLeafEntryId: "cached-leaf",
};
const sessions = inventory.sidebarListInput.rows.map((row) =>
  row.key === sessionKey ? session : row,
);
const message = (seq: number, text: string, id = `entry-${seq}`) => ({
  role: seq % 2 ? "user" : "assistant",
  content: text,
  __openclaw: { id, seq },
});
const cached = [message(1, "Saved question"), message(2, "Saved answer")];
const added = [message(3, "Next question"), message(4, "Next answer")];

async function expectTranscript(page: Page, texts: string[]): Promise<void> {
  await expect
    .poll(async () =>
      (
        await page
          .locator(".chat-pane-cache__pane--active .chat-thread .chat-text")
          .allTextContents()
      ).map((text) => text.trim()),
    )
    .toEqual(texts);
}

async function expectTranscriptReady(page: Page): Promise<void> {
  const pane = page.locator(".chat-pane-cache__pane--active");
  await expect
    .poll(() =>
      pane.evaluate((element: ChatPaneElement) => ({
        ready: element.transcriptReady,
        loading: element.transcriptLoading,
      })),
    )
    .toEqual({ ready: true, loading: false });
  expect(await pane.locator(".chat-history-error").count()).toBe(0);
}

suite.define(() => {
  it.each([
    "current",
    "new messages",
    "stale",
    "compaction",
    "branch change",
    "scope change",
  ] as const)("revalidates a persisted transcript after %s on warm reload", async (change) => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const roster = createTeamScaleSidebarListOwner({
        ...inventory.sidebarListInput,
        rows: sessions,
      });
      const gateway = await installMockGateway(
        page,
        {
          awaitInitialRoster: false,
          authMethod: "trusted-proxy",
          authMode: "trusted-proxy",
          sessionKey,
          sessions,
          presenceUsers: inventory.scenario.presenceUsers?.filter((person) => person.self),
          heldMethods: [
            "connect",
            "sessions.resolve",
            "sessions.messages.subscribe",
            "chat.startup",
          ],
          methodResponses: {
            "sessions.describe": { session },
            "sessions.resolve": { ok: true, ...session, agentId: "main" },
            "chat.startup": {
              sessionId: session.sessionId,
              sessionInfo: session,
              messages: cached,
              deltaCursor: cursor,
              hasMore: false,
              totalMessages: cached.length,
            },
          },
        },
        {
          requestHandlers: {
            "sessions.list": (params) => roster.list(isRecord(params) ? params : {}).result,
          },
        },
      );
      const updateSession = async (next: typeof session) => {
        roster.apply({ upsert: [next] });
        await gateway.setSessionsListResponse({
          sessions: sessions.map((row) => (row.key === sessionKey ? next : row)),
        });
        await gateway.setMethodResponse("sessions.describe", { session: next });
        await gateway.setMethodResponse("sessions.resolve", { ok: true, ...next, agentId: "main" });
      };
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await gateway.waitForRequest("connect");
      await gateway.resolveDeferred("connect");
      const cold = await gateway.waitForRequest("sessions.messages.subscribe", {
        match: { key: sessionKey },
      });
      expect(cold.params).toHaveProperty("initialHistory");
      expect(cold.params).not.toHaveProperty("initialHistory.cursor");
      await gateway.resolveDeferred("sessions.messages.subscribe");
      await expectTranscript(page, ["Saved question", "Saved answer"]);
      expect(await gateway.getRequests("chat.startup")).toEqual([]);
      await waitForControlUiInitialRoster(page);
      await page.waitForFunction(() =>
        Object.keys(localStorage).some((key) => key.startsWith("openclaw.control.bootRecord.v1:")),
      );
      const warmInput: Parameters<typeof persistColdLoadWarmState>[0] = {
        sessionKey,
        sidebarView: "sessions",
        offRosterSession: true,
      };
      const persisted = await page.evaluate(persistColdLoadWarmState, warmInput);
      expect(persisted.rosterContainsSession).toBe(false);
      expect(persisted.messages).toBe(2);

      const reset = change === "stale" || change === "compaction" || change === "branch change";
      const replacement = change === "compaction" || change === "branch change";
      const finalMessages = replacement
        ? [
            message(1, "Replacement question", "replacement-1"),
            message(2, "Replacement answer", "replacement-2"),
          ]
        : change === "current"
          ? cached
          : [...cached, ...added];
      const finalSession = {
        ...session,
        ...(change === "compaction" ? { sessionId: "compacted-session" } : {}),
        activeLeafEntryId:
          change === "branch change"
            ? "replacement-leaf"
            : change === "new messages" || change === "stale"
              ? "entry-4"
              : session.activeLeafEntryId,
      };
      const full = {
        sessionId: finalSession.sessionId,
        sessionInfo: finalSession,
        messages: finalMessages,
        deltaCursor: "current-history-cursor",
        hasMore: false,
        totalMessages: finalMessages.length,
      };
      await gateway.setMethodResponse(
        "chat.startup",
        reset
          ? { cases: [{ match: { cursor }, response: { kind: "reset" } }, { response: full }] }
          : {
              kind: "delta",
              sessionInfo: finalSession,
              deltaCursor: "current-history-cursor",
              messages:
                change === "current"
                  ? []
                  : added.map((entry) => ({
                      message: entry,
                      messageId: entry["__openclaw"].id,
                      messageSeq: entry["__openclaw"].seq,
                    })),
            },
      );
      // An eight-character off-roster reference requires authority after hello.
      await page.goto(new URL(`/chat/main/${sessionId.slice(0, 8)}`, suite.server.baseUrl).href);
      await gateway.waitForRequest("connect");
      expect(await gateway.getRequests("sessions.messages.subscribe", { key: sessionKey })).toEqual(
        [],
      );
      await gateway.resolveDeferred("connect");
      await waitForControlUiGatewayReady(page);
      await gateway.waitForRequest("sessions.resolve");
      expect(await gateway.getRequests("sessions.messages.subscribe", { key: sessionKey })).toEqual(
        [],
      );
      await gateway.resolveDeferred("sessions.resolve");
      const warm = await gateway.waitForRequest("sessions.messages.subscribe", {
        match: { key: sessionKey },
      });
      if (!isRecord(warm.params)) {
        throw new Error("Missing warm subscription parameters");
      }
      expect(warm.params).toMatchObject({ initialHistory: { cursor } });
      if (change === "scope change") {
        const hello = await evaluateControlUiContext(
          page,
          (context) => context.gateway.snapshot.hello,
        );
        if (!hello) {
          throw new Error("Missing authenticated Gateway hello");
        }
        const otherSession = {
          ...session,
          sessionId: "other-owner-session",
          activeLeafEntryId: "other-owner-leaf",
        };
        const otherMessages = [
          message(1, "Other owner question", "other-1"),
          message(2, "Other owner answer", "other-2"),
        ];
        await gateway.setMethodResponse("connect", {
          ...hello,
          auth: { ...hello.auth, recoveryScope: "other-history-owner" },
        });
        await updateSession(otherSession);
        await gateway.setMethodResponse("chat.startup", {
          sessionId: otherSession.sessionId,
          sessionInfo: otherSession,
          messages: otherMessages,
          deltaCursor: "other-owner-cursor",
          hasMore: false,
        });
        const connects = (await gateway.getRequests("connect")).length;
        const subscriptions = (
          await gateway.getRequests("sessions.messages.subscribe", { key: sessionKey })
        ).length;
        await gateway.deferNext("connect");
        await gateway.closeLatest(4000, "Synthetic history owner replacement");
        await gateway.waitForRequest("connect", { after: connects });
        await gateway.resolveDeferred("connect");
        await waitForControlUiGatewayReady(page);
        await gateway.waitForRequest("sessions.messages.subscribe", {
          match: { key: sessionKey },
          after: subscriptions,
        });
        await gateway.resolveDeferred(
          "sessions.messages.subscribe",
          {
            key: sessionKey,
            initialHistory: {
              ok: true,
              payload: {
                kind: "delta",
                sessionInfo: session,
                deltaCursor: "retired-owner-cursor",
                messages: added.map((entry) => ({
                  message: entry,
                  messageId: entry["__openclaw"].id,
                  messageSeq: entry["__openclaw"].seq,
                })),
              },
            },
          },
          { match: warm.params, exactParams: true },
        );
        await gateway.resolveDeferred("sessions.messages.subscribe");
        const scopedRefill = await gateway.waitForRequest("chat.startup");
        expect(scopedRefill.params).not.toHaveProperty("cursor");
        for (const text of ["Next question", "Next answer"]) {
          expect(await page.locator(".chat-thread").getByText(text, { exact: true }).count()).toBe(
            0,
          );
        }
        await gateway.resolveDeferred("chat.startup");
        await expectTranscriptReady(page);
        await expectTranscript(
          page,
          otherMessages.map((entry) => entry.content),
        );
        expect(await gateway.getRequests("chat.startup")).toHaveLength(1);
        return;
      }
      await expectTranscript(page, ["Saved question", "Saved answer"]);
      await updateSession(finalSession);
      await gateway.resolveDeferred("sessions.messages.subscribe");
      if (reset) {
        const refill = await gateway.waitForRequest("chat.startup");
        expect(refill.params).not.toHaveProperty("cursor");
        await expectTranscript(page, ["Saved question", "Saved answer"]);
        await gateway.resolveDeferred("chat.startup");
      }
      await expectTranscriptReady(page);
      await expectTranscript(
        page,
        finalMessages.map((entry) => entry.content),
      );
      expect(await gateway.getRequests("chat.startup")).toHaveLength(reset ? 1 : 0);
      expect(await gateway.getRequests("chat.history")).toEqual([]);
    });
  });
});
