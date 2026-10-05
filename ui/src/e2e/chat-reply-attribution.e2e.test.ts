import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Reply attribution" });
const sessionKey = "agent:main:reply-attribution";
const self = {
  senderId: "alice",
  senderName: "Alice Chen",
  senderIdentity: { type: "profile", id: "alice" },
};
const peer = {
  senderId: "jordan",
  senderName: "Jordan Lee",
  senderIdentity: { type: "profile", id: "jordan" },
};
const history = [
  {
    role: "assistant",
    content: "Review the release checklist before sharing it.",
    __openclaw: { id: "agent-source" },
  },
  {
    role: "user",
    content: "OK",
    __openclaw: { id: "self-reply", ...self, replyToId: "agent-source" },
  },
  {
    role: "user",
    content: "The desktop controls work.",
    __openclaw: { id: "peer-first", ...peer },
  },
  {
    role: "user",
    content: "The checklist is ready.",
    __openclaw: { id: "peer-reply", ...peer, replyToId: "self-reply" },
  },
  {
    role: "user",
    content: "I checked the mobile controls too.",
    __openclaw: { id: "peer-last", ...peer },
  },
  { role: "assistant", content: "The first answer.", __openclaw: { id: "answer-one" } },
  { role: "assistant", content: "The second answer.", __openclaw: { id: "answer-two" } },
].map((message, index) =>
  Object.assign(message, {
    timestamp: 1_800_000_000_000 + index * 1000,
    __openclaw: Object.assign({}, message["__openclaw"], { seq: index + 1 }),
  }),
);
const viewports = [
  { width: 1440, height: 1000, touch: false, theme: "light" },
  { width: 390, height: 1000, touch: true, theme: "dark" },
  { width: 820, height: 1180, touch: true, theme: "light" },
];

suite.define(() => {
  it("keeps live work attributed through streaming and completion", async () => {
    const liveSessionKey = "agent:main:dashboard:reply-strip-live-work";
    const runId = "review-run";
    const messages = [
      {
        role: "user",
        content: "Please review the release checklist.",
        __openclaw: { id: "earlier-prompt", ...self },
      },
      {
        role: "user",
        content: "Check the release notes and test results before we share it.",
        __openclaw: { id: "review-prompt", idempotencyKey: `${runId}:user`, ...peer },
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "read-release-notes",
        content: "The release notes describe the updated controls.",
        __openclaw: { id: "release-notes-work", runId },
      },
      {
        role: "toolResult",
        toolName: "exec",
        toolCallId: "check-test-results",
        content: "The focused tests passed.",
        __openclaw: { id: "test-results-work", runId },
      },
    ].map((message, index) =>
      Object.assign({}, message, {
        timestamp: 1_800_000_000_000 + index * 1000,
        __openclaw: Object.assign({}, message["__openclaw"], { seq: index + 1 }),
      }),
    );
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey: liveSessionKey,
          historyMessages: messages,
          inFlightRun: { runId, text: "" },
          sessionInfo: { key: liveSessionKey, activeRunIds: [runId], hasActiveRun: true },
          presenceUsers: [
            {
              self: true,
              id: "alice",
              identity: { type: "profile", id: "alice" },
              name: "Alice Chen",
            },
            { id: "jordan", identity: { type: "profile", id: "jordan" }, name: "Jordan Lee" },
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, liveSessionKey));
        const transcript = page.locator(".chat-thread-inner");
        await transcript.locator(".chat-reading-indicator").waitFor();
        await page.evaluate(async () => {
          document.documentElement.dataset.theme = "dark";
          document.documentElement.dataset.themeMode = "dark";
          await document.fonts.ready;
        });
        const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
        const artifactDir = artifactRoot
          ? createControlUiE2eArtifactDir("reply-strip-live-work", artifactRoot)
          : undefined;
        if (artifactDir) {
          await page.screenshot({ path: `${artifactDir}/live-work.png`, animations: "disabled" });
        }
        const response = transcript.locator(".chat-group.assistant", {
          has: page.locator(".chat-reading-indicator"),
        });
        const replyLine = response.getByRole("button", {
          name: "Replying to Jordan Lee",
          exact: true,
        });
        const activity = response.locator(".chat-activity-group__summary");
        expect(await activity.count()).toBe(1);
        await replyLine.waitFor();
        const lineBounds = await replyLine.boundingBox();
        const workBounds = await activity.boundingBox();
        expect(lineBounds).not.toBeNull();
        expect(workBounds).not.toBeNull();
        expect(lineBounds!.y + lineBounds!.height).toBeLessThanOrEqual(workBounds!.y);
        await activity.click();
        await response.locator(".chat-tool-msg-summary").filter({ hasText: "exec" }).click();
        await response.getByText("The focused tests passed.", { exact: true }).waitFor();

        const partialText = "The notes and test results agree.";
        await gateway.emitGatewayEvent("chat", {
          deltaText: partialText,
          message: { role: "assistant", content: [{ type: "text", text: partialText }] },
          runId,
          seq: 1,
          sessionKey: liveSessionKey,
          state: "delta",
        });
        await response.getByText(partialText, { exact: true }).waitFor();
        expect(await activity.getAttribute("aria-expanded")).toBe("true");
        expect(
          await response.getByText("The focused tests passed.", { exact: true }).isVisible(),
        ).toBe(true);
        expect(await response.locator(".chat-reply-attribution--reply").count()).toBe(1);

        const finalText =
          "The release checklist is ready. The controls are consistent across desktop and mobile.";
        await gateway.setHistoryMessages([
          ...messages,
          {
            role: "assistant",
            content: finalText,
            phase: "final_answer",
            stopReason: "stop",
            timestamp: 1_800_000_004_000,
            __openclaw: { id: "review-answer", runId, seq: 5 },
          },
        ]);
        await gateway.emitChatFinal({ runId, sessionKey: liveSessionKey, text: finalText });
        const answer = transcript.locator(".chat-group.assistant", {
          has: page.getByText(finalText, { exact: true }),
        });
        await answer.waitFor();
        expect(
          await answer.getByRole("button", { name: "Replying to Jordan Lee", exact: true }).count(),
        ).toBe(1);
        expect(await answer.locator(".chat-work-group").count()).toBe(1);
        const reply = answer.getByRole("button", { name: "Reply to message", exact: true });
        await reply.focus();
        await reply.press("Enter");
        const preview = page.locator(".chat-reply-preview").filter({
          has: page.getByRole("button", { name: "Cancel reply" }),
        });
        await expect
          .poll(() => preview.locator(".chat-reply-preview__text").textContent())
          .toBe(finalText);
        await preview.getByRole("button", { name: "Cancel reply" }).click();
        if (artifactDir) {
          await page.screenshot({
            path: `${artifactDir}/completed-work.png`,
            animations: "disabled",
          });
        }
      },
    );
  });

  it("updates a confirmed peer steer without claiming an unrelated continuation", async () => {
    const runId = "shared-review-run";
    const steer = {
      role: "user",
      content: "Focus on the mobile controls next.",
      __openclaw: {
        id: "peer-steer",
        idempotencyKey: "peer-steer-run:user",
        senderId: "casey",
        senderName: "Casey Park",
        senderIdentity: { type: "profile", id: "casey" },
      },
    };
    const answerText = "The mobile controls are ready.";
    const unrelatedText = "The independent background check is complete.";
    const messages = [
      {
        role: "user",
        content: "Check the release controls.",
        __openclaw: { id: "shared-review-prompt", idempotencyKey: `${runId}:user`, ...peer },
      },
      {
        role: "assistant",
        content: "The desktop controls look consistent.",
        __openclaw: { id: "before-steer", runId },
      },
      steer,
      {
        role: "assistant",
        content: answerText,
        phase: "final_answer",
        stopReason: "stop",
        __openclaw: { id: "after-steer", runId },
      },
      {
        role: "toolResult",
        toolName: "exec",
        toolCallId: "independent-check",
        content: "Independent background work finished.",
        __openclaw: { id: "independent-work", runId: "independent-run" },
      },
      {
        role: "assistant",
        content: unrelatedText,
        phase: "final_answer",
        stopReason: "stop",
        __openclaw: { id: "independent-answer", runId: "independent-run" },
      },
    ].map((message, index) =>
      Object.assign({}, message, {
        timestamp: 1_800_000_000_000 + index * 1000,
        __openclaw: Object.assign({}, message["__openclaw"], { seq: index + 1 }),
      }),
    );
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, { sessionKey, historyMessages: messages });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const answer = page.locator(".chat-group.assistant", {
        has: page.getByText(answerText, { exact: true }),
      });
      const earlier = page.locator(".chat-group.assistant", {
        has: page.getByText("The desktop controls look consistent.", { exact: true }),
      });
      await answer.waitFor();
      await expect
        .poll(() =>
          answer.getByRole("button", { name: "Replying to Jordan Lee", exact: true }).count(),
        )
        .toBe(1);
      const updatedSteer = {
        ...messages[2],
        __openclaw: { ...messages[2]!["__openclaw"], steerTargetRunId: runId },
      };
      await gateway.setHistoryMessages(
        messages.map((message, index) => (index === 2 ? updatedSteer : message)),
      );
      await gateway.emitGatewayEvent("session.message", {
        message: updatedSteer,
        messageId: "peer-steer",
        messageSeq: 3,
        sessionKey,
      });
      await expect
        .poll(() =>
          answer.getByRole("button", { name: "Replying to Casey Park", exact: true }).count(),
        )
        .toBe(1);
      expect(
        await earlier.getByRole("button", { name: "Replying to Jordan Lee", exact: true }).count(),
      ).toBe(1);
      expect(
        await answer.getByText("The desktop controls look consistent.", { exact: true }).count(),
      ).toBe(0);
      const unrelated = page.locator(".chat-group.assistant", {
        has: page.getByText(unrelatedText, { exact: true }),
      });
      expect(await unrelated.locator(".chat-reply-attribution--reply").count()).toBe(0);
      expect(await unrelated.getByText(answerText, { exact: true }).count()).toBe(0);
      const reply = answer.getByRole("button", { name: "Reply to message", exact: true });
      await reply.focus();
      await reply.press("Enter");
      const preview = page.locator(".chat-reply-preview").filter({
        has: page.getByRole("button", { name: "Cancel reply" }),
      });
      await expect
        .poll(() => preview.locator(".chat-reply-preview__text").textContent())
        .toBe(answerText);
    });
  });

  it("keeps a post-steer Reply control focused and anchored through history pagination", async () => {
    const runId = "paginated-review-run";
    const answerText = "The post-steer mobile review is complete.";
    const paginatedSessionKey = "agent:main:dashboard:paginated-reply";
    const message = (
      seq: number,
      fields: Record<string, unknown>,
      metadata: Record<string, unknown> = {},
    ) => ({
      ...fields,
      timestamp: 1_800_000_000_000 + seq,
      __openclaw: { id: `pagination-${seq}`, seq, ...metadata },
    });
    const recent = [
      message(
        1001,
        { role: "user", content: "Focus on the mobile controls." },
        {
          ...self,
          steerTargetRunId: runId,
        },
      ),
      message(
        1002,
        { role: "assistant", content: answerText, phase: "final_answer", stopReason: "stop" },
        { runId },
      ),
      ...Array.from({ length: 22 }, (_, index) =>
        message(1003 + index, {
          role: index % 2 ? "assistant" : "user",
          content: `Later entry ${index + 1}. ${"Independent conversation detail. ".repeat(8)}`,
        }),
      ),
    ];
    const older = [
      ...Array.from({ length: 18 }, (_, index) =>
        message(980 + index, {
          role: index % 2 ? "assistant" : "user",
          content: `Older entry ${index + 1}.`,
        }),
      ),
      message(
        998,
        { role: "user", content: "Review the release controls." },
        { ...peer, idempotencyKey: `${runId}:user` },
      ),
      message(
        999,
        { role: "assistant", content: "The desktop controls look consistent." },
        { runId },
      ),
      message(
        1000,
        {
          role: "toolResult",
          toolName: "exec",
          toolCallId: "earlier-review-check",
          content: "The desktop checks passed.",
        },
        { runId },
      ),
    ];
    const loadedCount = recent.length + older.length;
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey: paginatedSessionKey,
          sessions: [{ key: paginatedSessionKey, sessionId: "paginated-reply-session" }],
          methodResponses: {
            "chat.startup": {
              messages: recent,
              hasMore: true,
              nextOffset: recent.length,
              totalMessages: loadedCount,
              sessionId: "paginated-reply-session",
            },
            "chat.history": {
              messages: older,
              hasMore: false,
              nextOffset: loadedCount,
              totalMessages: loadedCount,
              sessionId: "paginated-reply-session",
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, paginatedSessionKey));
        const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
        await thread.getByText(/^Later entry 22\./).waitFor();
        const historyRequests = await gateway.deferNext("chat.history");
        await thread.hover();
        await page.mouse.wheel(0, -1_000_000);
        const request = await gateway.waitForRequest("chat.history", { after: historyRequests });
        expect(request.params).toMatchObject({
          sessionKey: paginatedSessionKey,
          offset: recent.length,
        });
        // Hold the real pagination response, not a terminal reload. Upward scrolling
        // already requests the page; clicking Show earlier here would race that request.
        const answer = thread.locator(".chat-group.assistant", {
          has: page.getByText(answerText, { exact: true }),
        });
        const reply = answer.getByRole("button", { name: "Reply to message", exact: true });
        await reply.focus();
        const held = await reply.elementHandle();
        expect(held).not.toBeNull();
        const before = await reply.boundingBox();
        expect(before).not.toBeNull();
        expect(await held!.evaluate((element) => document.activeElement === element)).toBe(true);
        const offset = await thread.evaluate((element) => element.scrollTop);
        const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
        const artifactDir = artifactRoot
          ? createControlUiE2eArtifactDir("reply-pagination", artifactRoot)
          : undefined;
        if (artifactDir) {
          await page.screenshot({
            path: `${artifactDir}/before-prepend.png`,
            animations: "disabled",
          });
        }
        await gateway.resolveDeferred("chat.history");
        // An increased native extent and a removed page boundary prove that the
        // fetched page committed; a history-state assignment alone is insufficient.
        await expect
          .poll(() => thread.evaluate((element) => element.scrollTop))
          .toBeGreaterThan(offset + 100);
        await thread
          .getByRole("button", { name: "Loading earlier…", exact: true })
          .waitFor({ state: "detached" });
        await expect
          .poll(() =>
            held!.evaluate((element) => ({
              connected: element.isConnected,
              focused: document.activeElement === element,
            })),
          )
          .toEqual({ connected: true, focused: true });
        expect(await reply.evaluate((element, prior) => element === prior, held)).toBe(true);
        const after = await reply.boundingBox();
        expect(after).not.toBeNull();
        expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(2);
        expect(
          await answer.getByRole("button", { name: "Replying to Alice Chen", exact: true }).count(),
        ).toBe(1);
        if (artifactDir) {
          await page.screenshot({
            path: `${artifactDir}/after-prepend.png`,
            animations: "disabled",
          });
        }
        await reply.press("Enter");
        const preview = page
          .locator(".chat-reply-preview")
          .filter({ has: page.getByRole("button", { name: "Cancel reply" }) });
        await expect
          .poll(() => preview.locator(".chat-reply-preview__text").textContent())
          .toBe(answerText);
        expect(await gateway.getRequests("chat.history")).toHaveLength(historyRequests + 1);
      },
    );
  });

  it("reveals native tool output in its own mixed-run frame with keyboard toggles", async () => {
    const mixedSessionKey = "agent:main:dashboard:mixed-tool-output";
    const runId = "mixed-live-review";
    const output = "The native read confirms the mobile release controls.";
    const messages = [
      {
        role: "user",
        content: "Review the release controls.",
        __openclaw: { id: "mixed-prompt", idempotencyKey: `${runId}:user`, ...peer },
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        role: "toolResult",
        toolName: "exec",
        toolCallId: `independent-${index}`,
        content: `Independent check ${index} finished.`,
        __openclaw: { id: `mixed-work-${index}`, runId: `background-run-${index}` },
      })),
      {
        role: "toolResult",
        toolName: "exec",
        toolCallId: "current-run-check",
        content: "The current review is in progress.",
        __openclaw: { id: "current-work", runId },
      },
    ].map((message, index) =>
      Object.assign(message, {
        timestamp: 1_800_000_000_000 + index,
        __openclaw: Object.assign({}, message["__openclaw"], { seq: index + 1 }),
      }),
    );
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey: mixedSessionKey,
          historyMessages: messages,
          inFlightRun: { runId, text: "Checking the mobile release controls." },
          sessionInfo: { key: mixedSessionKey, activeRunIds: [runId], hasActiveRun: true },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, mixedSessionKey));
        const frame = page.locator(".chat-group.assistant", {
          has: page.getByText("Checking the mobile release controls.", { exact: true }),
        });
        await frame.waitFor();
        await gateway.emitGatewayEvent("agent", {
          sessionKey: mixedSessionKey,
          runId,
          seq: 1,
          ts: 1_800_000_001_000,
          stream: "tool",
          data: {
            phase: "start",
            name: "read",
            toolCallId: "native-release-read",
            args: { path: "RELEASE.md" },
          },
        });
        const activity = frame.locator(".chat-activity-group__summary");
        await activity.waitFor();
        expect(await activity.count()).toBe(1);
        await activity.focus();
        await activity.press("Enter");
        const row = frame.locator(".chat-tool-row--file", { hasText: "RELEASE.md" });
        await expect.poll(() => row.getAttribute("class")).toContain("chat-tool-row--running");
        await gateway.emitGatewayEvent("agent", {
          sessionKey: mixedSessionKey,
          runId,
          seq: 2,
          ts: 1_800_000_001_001,
          stream: "tool",
          data: {
            phase: "result",
            name: "read",
            toolCallId: "native-release-read",
            result: { content: [{ type: "text", text: output }] },
          },
        });
        await expect.poll(() => row.getAttribute("class")).not.toContain("chat-tool-row--running");
        // File rows contain a separate workspace link. Use the actual disclosure
        // button instead of a center-pointer click on the file or an outer group.
        const toggle = row.locator("button.chat-tool-row__toggle");
        expect(await toggle.getAttribute("aria-expanded")).toBe("false");
        await toggle.focus();
        await toggle.press("Enter");
        await frame.getByText(output, { exact: true }).waitFor();
        expect(await toggle.getAttribute("aria-expanded")).toBe("true");
        expect(await frame.getByText(/Independent check \d+ finished\./).count()).toBe(0);
        expect(await frame.locator(".chat-tool-msg-summary").count()).toBe(2);
        const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
        if (artifactRoot) {
          const artifactDir = createControlUiE2eArtifactDir("mixed-native-tool", artifactRoot);
          await page.screenshot({
            path: `${artifactDir}/native-tool-output.png`,
            animations: "disabled",
          });
        }
        await toggle.press("Enter");
        await frame.getByText(output, { exact: true }).waitFor({ state: "hidden" });
        expect(await toggle.getAttribute("aria-expanded")).toBe("false");
        await toggle.press("Enter");
        await frame.getByText(output, { exact: true }).waitFor();
        expect(await toggle.evaluate((element) => document.activeElement === element)).toBe(true);
      },
    );
  });

  it.each(viewports)(
    "keeps participant actions owned by their message at $width px",
    async ({ width, height, touch, theme }) => {
      await suite.withPage(
        { viewport: { width, height }, locale: "en-US", hasTouch: touch },
        async ({ page }) => {
          await installMockGateway(page, {
            sessionKey,
            historyMessages: history,
            presenceUsers: [
              {
                self: true,
                id: "alice",
                identity: { type: "profile", id: "alice" },
                name: "Alice Chen",
              },
            ],
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await page.evaluate(async (value) => {
            document.documentElement.dataset.theme = value;
            document.documentElement.dataset.themeMode = value;
            await document.fonts.ready;
          }, theme);
          expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(touch);
          const own = page.locator('[data-entry-id="self-reply"]');
          const first = page.locator('[data-entry-id="peer-first"]');
          const reply = page.locator('[data-entry-id="peer-reply"]');
          const last = page.locator('[data-entry-id="peer-last"]');
          await reply.waitFor();
          expect(await own.locator(":scope > .chat-reply-attribution--inline").count()).toBe(1);
          expect(await reply.locator(".chat-reply-attribution").count()).toBe(0);
          expect(
            await reply
              .locator("..")
              .getByRole("button", { name: "Replying to You", exact: true })
              .count(),
          ).toBe(1);
          const group = page.locator('.chat-group--peer:has([data-entry-id="peer-reply"])');
          const actionFor = async (id: string) => {
            const key = await page
              .locator('[data-entry-id="' + id + '"]')
              .getAttribute("data-message-id");
            const owner = group.locator('[data-message-actions-for="' + key + '"]');
            expect(await owner.count()).toBe(1);
            return owner.getByRole("button", { name: "Reply to message", exact: true });
          };
          const geometry = () =>
            group.evaluate((element) => {
              const thread = element.closest(".chat-thread")!;
              return [...element.querySelectorAll(".chat-bubble")].map((bubble) => {
                const bounds = bubble.getBoundingClientRect();
                return {
                  top: bounds.top + thread.scrollTop,
                  height: bounds.height,
                  width: bounds.width,
                };
              });
            });
          const interactiveOwners = () =>
            group
              .locator("[data-message-actions-for]")
              .evaluateAll((owners) =>
                owners
                  .filter((owner) =>
                    [...owner.querySelectorAll("button")].some(
                      (button) => getComputedStyle(button).pointerEvents !== "none",
                    ),
                  )
                  .map((owner) => owner.getAttribute("data-message-actions-for")),
              );
          await first.scrollIntoViewIfNeeded();
          const resting = await geometry();
          const messages = [
            ["peer-first", first, "The desktop controls work."],
            ["peer-reply", reply, "The checklist is ready."],
            ["peer-last", last, "I checked the mobile controls too."],
          ] as const;
          // Focus must reveal every native owner without a preceding hover/tap.
          for (const [id, bubble, content] of messages) {
            const action = await actionFor(id);
            const key = await bubble.getAttribute("data-message-id");
            await action.focus();
            await expect
              .poll(() => action.evaluate((button) => Number(getComputedStyle(button).opacity)))
              .toBeGreaterThan(0.5);
            await expect.poll(interactiveOwners).toEqual([key]);
            expect(await geometry()).toEqual(resting);
            // Earlier message rows align to their bubble; the final group footer
            // keeps its native metadata/action layout.
            if (!touch && id !== "peer-last") {
              const actionBounds = await action.boundingBox();
              const bubbleBounds = await bubble.boundingBox();
              expect(actionBounds).not.toBeNull();
              expect(bubbleBounds).not.toBeNull();
              expect(Math.abs(actionBounds!.x - bubbleBounds!.x)).toBeLessThanOrEqual(1);
            }
            if (touch) {
              expect(
                await action.evaluate((button) => {
                  const bounds = button.getBoundingClientRect();
                  // The 44px tap area grows up from the button's bottom edge.
                  return [1, 43].map((offset) =>
                    button.contains(
                      document.elementFromPoint(
                        bounds.left + bounds.width / 2,
                        bounds.bottom - offset,
                      ),
                    ),
                  );
                }),
              ).toEqual([true, true]);
            }
            await action.press("Enter");
            const preview = page
              .locator(".chat-reply-preview")
              .filter({ has: page.getByRole("button", { name: "Cancel reply" }) });
            await expect
              .poll(() => preview.locator(".chat-reply-preview__text").textContent())
              .toBe(content);
            await preview.getByRole("button", { name: "Cancel reply" }).click();
            await action.evaluate((button) => button.blur());
            await page.mouse.move(0, 0);
          }
          await expect.poll(interactiveOwners).toEqual([]);
          // Transfer directly between ordinary, reply-wrapped, and final bubbles.
          // No intervening dismiss or action may reset the previous reveal.
          for (const [id, bubble] of messages) {
            const action = await actionFor(id);
            const key = await bubble.getAttribute("data-message-id");
            if (touch) {
              await bubble.locator(".chat-text").tap();
            } else {
              await bubble.hover();
            }
            await expect
              .poll(() => action.evaluate((button) => Number(getComputedStyle(button).opacity)))
              .toBeGreaterThan(0.5);
            await expect.poll(interactiveOwners).toEqual([key]);
            expect(await geometry()).toEqual(resting);
          }
          if (touch) {
            // Tapping the same final message still dismisses its controls.
            await last.locator(".chat-text").tap();
          } else {
            await page.mouse.move(0, 0);
          }
          await expect.poll(interactiveOwners).toEqual([]);
        },
      );
    },
  );
});
