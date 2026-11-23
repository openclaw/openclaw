import { expect, it } from "vitest";
import {
  controlUiSessionPath,
  installMockGateway,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { chatMessage, chatSessionListResponse } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI retained pane hydration",
  startServerBeforeBrowser: true,
});

const sessionKeys = ["agent:main:perf-a", "agent:main:perf-b", "agent:main:perf-c"] as const;
const hydrationMethods = ["sessions.branches.list", "sessions.companion.state"];

function sessionHydrationMethods(requests: MockGatewayRequest[], sessionKey: string): string[] {
  return requests
    .filter((request) => {
      const params = request.params as { sessionKey?: unknown } | undefined;
      return params?.sessionKey === sessionKey && hydrationMethods.includes(request.method);
    })
    .map((request) => request.method)
    .toSorted();
}

suite.define(() => {
  it("recovers the saved answer when a run finishes while another chat is open", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1440 } }, async ({ page }) => {
      const [source, other] = sessionKeys;
      const runId = "background-read";
      const running = createControlUiSessionRow(source, "Workspace check", 1, {
        status: "running",
        hasActiveRun: true,
        activeRunIds: [runId],
      });
      const finished = {
        ...running,
        status: "done",
        hasActiveRun: false,
        activeRunIds: [],
        lastRunId: runId,
        updatedAt: 2,
      };
      const question = "Check the workspace.";
      const answer = "The workspace is clean.";
      const messages = [
        chatMessage("user", question),
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            { type: "toolCall", name: "read", id: "inspect", arguments: { path: "README.md" } },
          ],
        },
        {
          role: "toolResult",
          toolName: "read",
          toolCallId: "inspect",
          content: "Inspection completed.",
        },
      ];
      const gateway = await installMockGateway(page, {
        sessionKey: source,
        subscriptionInitialHistory: false,
        sessions: [running, createControlUiSessionRow(other, "Other conversation", 1)],
        sessionTranscripts: {
          [source]: { messages, inFlightRun: { runId, startedAt: 1, text: "" } },
          [other]: { messages: [chatMessage("user", "Another chat.")] },
        },
      });
      const link = (key: string) =>
        page.locator(`.sidebar-recent-session[data-session-key="${key}"] a`);
      const visible = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      await page.goto(new URL(controlUiSessionPath(source), suite.server.baseUrl).href);
      await visible.getByText(question, { exact: true }).waitFor();
      await link(other).click();
      await visible.getByText("Another chat.", { exact: true }).waitFor();
      await gateway.setSessionRow(finished);
      await gateway.setMethodResponse("chat.history", {
        sessionId: finished.sessionId,
        sessionInfo: finished,
        messages: [...messages, chatMessage("assistant", answer)],
      });
      // The roster reports completion, but this pane hasn't received the message body.
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey: source,
        agentId: "main",
        phase: "end",
        ts: Date.now(),
        session: finished,
      });
      await link(source).click();
      await visible
        .locator(".chat-bubble")
        .getByText(answer, { exact: true })
        .waitFor({ timeout: 5_000 });
      const caughtUp = (await gateway.getRequests("chat.history", { sessionKey: source })).length;
      await link(other).click();
      await visible.getByText("Another chat.", { exact: true }).waitFor();
      await link(source).click();
      await visible.locator(".chat-bubble").getByText(answer, { exact: true }).waitFor();
      expect(await gateway.getRequests("chat.history", { sessionKey: source })).toHaveLength(
        caughtUp,
      );
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it("hydrates only the visible retained session after reconnect", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1440 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        subscriptionInitialHistory: false,
        featureMethods: [
          "artifacts.list",
          "chat.metadata",
          "chat.startup",
          "sessions.diff",
          "sessions.files.list",
          "sessions.branches.list",
          "sessions.companion.state",
        ],
        historyMessages: [{ role: "assistant", content: "Retained session transcript." }],
        methodResponses: {
          "sessions.branches.list": { branches: [] },
          "sessions.companion.state": { exchanges: [] },
          "sessions.list": chatSessionListResponse(
            sessionKeys.map((key, index) => ({
              key,
              kind: "direct",
              label: `Perf ${index + 1}`,
              updatedAt: sessionKeys.length - index,
            })),
          ),
        },
        sessionKey: sessionKeys[0],
      });
      const hydrationSince = async (key: string, offset = 0) =>
        sessionHydrationMethods((await gateway.getRequests()).slice(offset), key);
      const count = async (method: string) => (await gateway.getRequests(method)).length;
      const link = (key: string) =>
        page.locator(`.sidebar-recent-session[data-session-key="${key}"] a`);
      const expectRoute = (key: string) =>
        expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(key));
      await page.goto(new URL(controlUiSessionPath(sessionKeys[0]), suite.server.baseUrl).href);
      // A route URL can settle before its lazy pane mounts and becomes retainable.
      await expect.poll(() => page.locator("openclaw-chat-pane").count()).toBe(1);
      for (const [index, key] of sessionKeys.slice(1).entries()) {
        if (key === sessionKeys[2]) {
          await gateway.deferNext("chat.startup", { sessionKey: key });
        }
        await link(key).click();
        await expectRoute(key);
        await expect.poll(() => page.locator("openclaw-chat-pane").count()).toBe(index + 2);
      }
      // Initial after-paint hydration belongs outside the reconnect measurement.
      const startupScope = { match: { sessionKey: sessionKeys[2] } };
      await gateway.waitForRequest("chat.startup", startupScope);
      await gateway.resolveDeferred("chat.startup", undefined, startupScope);
      await expect.poll(() => hydrationSince(sessionKeys[2])).toEqual(hydrationMethods);
      const visiblePane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      await visiblePane.getByText("Retained session transcript.", { exact: true }).waitFor();
      const before = (await gateway.getRequests()).length;
      const connectBefore = await count("connect");
      await gateway.closeLatest(1012, "retained pane reconnect proof");
      await expect.poll(() => count("connect"), { timeout: 10_000 }).toBeGreaterThan(connectBefore);
      await expect
        .poll(() => hydrationSince(sessionKeys[2], before), { timeout: 10_000 })
        .toEqual(hydrationMethods);
      const requests = (await gateway.getRequests()).slice(before);
      const eagerMethods = new Set(["sessions.files.list", "artifacts.list"]);
      expect(requests.filter(({ method }) => eagerMethods.has(method))).toEqual([]);
      await visiblePane.getByText("Retained session transcript.", { exact: true }).waitFor();
      expect(sessionKeys.map((key) => sessionHydrationMethods(requests, key).length)).toEqual([
        0, 0, 2,
      ]);
      const beforeEvents = (await gateway.getRequests()).length;
      const sessionListCount = await count("sessions.list");
      const branchListCount = await count("sessions.branches.list");
      const hiddenSessionKey = sessionKeys[0];
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey: hiddenSessionKey,
        agentId: "main",
        reason: "branch-switch",
      });
      await gateway.emitGatewayEvent("chat", {
        sessionKey: hiddenSessionKey,
        runId: "run-hidden",
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
      });
      await page.waitForFunction((sessionKey) => {
        const pane = [...document.querySelectorAll("openclaw-chat-pane")].find(
          (element) => (element as HTMLElement & { sessionKey?: string }).sessionKey === sessionKey,
        ) as (HTMLElement & { state?: { chatMessages?: unknown[] } }) | undefined;
        return JSON.stringify(pane?.state?.chatMessages ?? []).includes("Done.");
      }, hiddenSessionKey);
      await expect.poll(() => count("sessions.list")).toBeGreaterThan(sessionListCount);
      expect(await gateway.getRequests("sessions.branches.list")).toHaveLength(branchListCount);
      const afterEvents = (await gateway.getRequests()).slice(beforeEvents);
      expect(sessionHydrationMethods(afterEvents, hiddenSessionKey)).toHaveLength(0);
      await link(hiddenSessionKey).click();
      await expectRoute(hiddenSessionKey);
      await expect
        .poll(() => hydrationSince(hiddenSessionKey, before + requests.length))
        .toEqual(hydrationMethods);
    });
  });
});
