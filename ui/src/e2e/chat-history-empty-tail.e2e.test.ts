import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { requireRecord } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Empty history tail" });
const sessionId = "empty-tail-session";
const sessionInfo = { key: "agent:main:main", kind: "direct" as const, sessionId };
const olderMessages = [
  {
    role: "user",
    content: "Can you check the report?",
    __openclaw: { id: "earlier-user", seq: 1 },
  },
  {
    role: "assistant",
    content: "The report is ready for review.",
    __openclaw: { id: "earlier-assistant", seq: 2 },
  },
];
const hiddenActivity = Array.from({ length: 80 }, (_, index) => ({
  role: "toolResult",
  toolName: "read",
  toolCallId: `read-${index}`,
  content: [{ type: "text", text: "Synthetic tool result" }],
  __openclaw: { id: `activity-${index}`, seq: 121 + index },
}));

suite.define(() => {
  it.each([
    { name: "empty projection", messages: [], height: 720 },
    { name: "hidden activity in a short viewport", messages: hiddenActivity, height: 480 },
  ])(
    "waits for reader intent before loading earlier conversation through a $name",
    async ({ name, messages, height }) => {
      await suite.withPage({ viewport: { width: 1280, height } }, async ({ page }) => {
        const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR
          ? createControlUiE2eArtifactDir(name)
          : undefined;
        const historyPages = [
          {
            match: { offset: 80 },
            response: {
              messages: [],
              hasMore: true,
              nextOffset: 160,
              totalMessages: 200,
              sessionId,
              sessionInfo,
            },
          },
          {
            match: { offset: 160 },
            response: {
              messages: olderMessages,
              hasMore: false,
              totalMessages: 200,
              sessionId,
              sessionInfo,
            },
          },
        ];
        const gateway = await installMockGateway(page, {
          sessions: [sessionInfo],
          methodResponses: {
            "config.get": { config: { ui: { prefs: { chatShowToolCalls: false } } } },
            "chat.startup": {
              messages,
              hasMore: true,
              nextOffset: 80,
              totalMessages: 200,
              sessionId,
              sessionInfo,
            },
            "chat.history": {
              cases: historyPages,
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
        const showEarlier = thread.getByRole("button", { name: "Show earlier", exact: true });
        await gateway.waitForRequest("chat.startup");
        await page.waitForFunction(() => {
          const pane = document.querySelector(".chat-pane-cache__pane--active") as
            | (HTMLElement & { state: { chatLoading: boolean } })
            | null;
          return pane && !pane.state.chatLoading;
        });
        // Observe native layout delivery, including IntersectionObserver, without
        // waiting for a request that a settled cold load must never issue.
        await page.evaluate(async () => {
          for (let frame = 0; frame < 24; frame += 1) {
            await new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            });
          }
        });
        const bootRequests = await gateway.getRequests("chat.history");
        const bootHistoryPayloadBytes = bootRequests.reduce((bytes, request) => {
          const response = historyPages.find(
            (entry) => entry.match.offset === requireRecord(request.params).offset,
          )?.response;
          return bytes + (response ? Buffer.byteLength(JSON.stringify(response)) : 0);
        }, 0);
        console.log(
          JSON.stringify({
            name,
            bootHistoryRequests: bootRequests.length,
            bootHistoryPayloadBytes,
          }),
        );
        if (artifactDir) {
          const frame = await takeControlUiScreenshotFrame(page, thread, [thread], {
            animations: "disabled",
          });
          await writeFile(path.join(artifactDir, "boot.png"), frame.png);
        }
        expect(bootRequests).toHaveLength(0);
        await gateway.deferNext("chat.history");
        await showEarlier.waitFor();
        await thread.hover();
        await page.mouse.wheel(0, -1000);
        await gateway.waitForRequest("chat.history");
        expect(await page.locator(".agent-chat__welcome").count()).toBe(0);
        await gateway.resolveDeferred("chat.history");
        await showEarlier.waitFor();
        await showEarlier.click();
        const reply = page
          .locator(".chat-text")
          .getByText("The report is ready for review.", { exact: true });
        await reply.waitFor();
        await page
          .locator(".chat-text")
          .getByText("Can you check the report?", { exact: true })
          .waitFor();
        expect(await page.locator(".agent-chat__welcome").count()).toBe(0);
        expect(await gateway.getRequests("chat.history")).toMatchObject([
          { params: { offset: 80 } },
          { params: { offset: 160 } },
        ]);
        if (artifactDir) {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".chat-thread"),
            [reply],
            { animations: "disabled" },
          );
          await writeFile(path.join(artifactDir, "conversation.png"), frame.png);
        }
      });
    },
  );

  it("still welcomes a genuinely empty conversation without requesting older history", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 720 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessions: [sessionInfo],
        historyMessages: [],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".agent-chat__welcome").waitFor();
      expect(await gateway.getRequests("chat.history")).toEqual([]);
    });
  });
});
