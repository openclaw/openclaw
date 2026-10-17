import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { expectHistoryBoundaryState } from "./chat-history-boundary.test-support.ts";
import { expectTranscriptLayoutCommitted } from "./claude-sessions.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Chat history loading",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

suite.define(() => {
  it("keeps the cached history action disabled while reconnect hydration is pending", async () => {
    const page = await suite.browser.newPage({ viewport: { width: 1280, height: 900 } });
    const messages = Array.from({ length: 40 }, (_, index) => ({
      __openclaw: { seq: index + 41 },
      role: index % 2 ? "assistant" : "user",
      content: [{ type: "text", text: `Cached conversation message ${index + 41}` }],
      timestamp: 1_800_000_000_000 + index,
    }));
    const history = {
      messages,
      hasMore: true,
      nextOffset: 40,
      totalMessages: 80,
      sessionId: "cached-history-hydration",
      thinkingLevel: null,
    };
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup"],
      methodResponses: { "chat.startup": history, "chat.history": history },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await page.getByText("Cached conversation message 80", { exact: true }).waitFor();
    await expectHistoryBoundaryState(page, false);

    const startupCount = (await gateway.getRequests("chat.startup")).length;
    await gateway.deferNext("chat.startup");
    await gateway.setGatewayBootId("cached-history-reconnect");
    await gateway.closeLatest(1012, "restart");
    await gateway.waitForRequest("chat.startup", { after: startupCount });
    await expectHistoryBoundaryState(page, true);
    await page.getByText("Cached conversation message 80", { exact: true }).waitFor();

    await gateway.resolveDeferred("chat.startup");
    await expectHistoryBoundaryState(page, false);
    await page.close();
  });
  it.each(["cold", "warm"])(
    "fills once on %s reload, then pages to the beginning on upward input",
    async (temperature) => {
      const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      const artifactDir = artifactRoot
        ? createControlUiE2eArtifactDir("chat-history-underfill", artifactRoot)
        : undefined;
      const viewport = { width: 1280, height: 900 };
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport,
        ...(artifactDir ? { recordVideo: { dir: artifactDir, size: viewport } } : {}),
      });
      const page = await context.newPage();
      const proofVideo = page.video();
      const historyMessage = (seq: number, role: "assistant" | "user", text: string) => ({
        __openclaw: { seq },
        content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
        role,
        timestamp: 1_800_000_000_000 + seq,
      });
      const recent = [
        historyMessage(21, "user", "Recent question"),
        historyMessage(22, "assistant", "Recent answer"),
      ];
      // Consecutive assistant records collapse into one rendered group, so this
      // page advances the raw offset without filling the real transcript viewport.
      const firstOlderPage = Array.from({ length: 4 }, (_, index) =>
        historyMessage(index + 17, "assistant", `Short older answer ${index + 17}`),
      );
      const secondOlderPage = Array.from({ length: 16 }, (_, index) => {
        const seq = index + 1;
        const role = seq % 2 === 0 ? "assistant" : "user";
        return historyMessage(
          seq,
          role,
          `Scrollable older ${role} message ${seq}\n${"Transcript detail line\n".repeat(3)}`,
        );
      });
      const gateway = await installMockGateway(page, {
        deferredMethods: ["chat.history"],
        featureMethods: ["chat.metadata", "chat.startup"],
        methodResponses: {
          "chat.startup": {
            messages: recent,
            hasMore: true,
            nextOffset: 2,
            totalMessages: 30,
            sessionId: "native-underfill-pagination",
            thinkingLevel: null,
          },
          "chat.history": {
            cases: [
              {
                match: { offset: 2 },
                response: {
                  messages: firstOlderPage,
                  hasMore: true,
                  nextOffset: 6,
                  totalMessages: 30,
                  sessionId: "native-underfill-pagination",
                  thinkingLevel: null,
                },
              },
              {
                match: { offset: 6 },
                response: {
                  messages: secondOlderPage,
                  hasMore: false,
                  totalMessages: 30,
                  sessionId: "native-underfill-pagination",
                  thinkingLevel: null,
                },
              },
            ],
          },
        },
      });

      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
        const thread = pane.locator(".chat-thread");
        await page.getByText("Recent answer", { exact: true }).waitFor();
        if (temperature === "warm") {
          await gateway.waitForRequest("chat.history");
          await gateway.resolveDeferred("chat.history");
          await expectHistoryBoundaryState(pane, false);
          await expectTranscriptLayoutCommitted(thread);
          await page.reload();
          await page.getByText("Recent answer", { exact: true }).waitFor();
        }
        await expectTranscriptLayoutCommitted(thread);
        await expect
          .poll(async () =>
            (await gateway.getRequests("chat.history")).map(
              (request) => (request.params as { offset?: number } | undefined)?.offset,
            ),
          )
          .toEqual([2]);
        await expectHistoryBoundaryState(pane, true);
        expect(
          await thread.evaluate((element) => element.scrollHeight <= element.clientHeight),
        ).toBe(true);
        if (artifactDir) {
          await writeFile(
            path.join(artifactDir, "00-native-history-initial-underfill-loading.png"),
            await takeControlUiViewportScreenshot(page, pane.locator(".chat-main"), [
              pane.locator('.chat-history-boundary__action[aria-busy="true"]'),
            ]),
          );
        }

        await gateway.deferNext("chat.history", { offset: 6 });
        await gateway.resolveDeferred("chat.history");
        await expectHistoryBoundaryState(pane, false);
        await expectTranscriptLayoutCommitted(thread);
        expect((await gateway.getRequests("chat.history")).length).toBe(1);
        expect(
          await thread.evaluate((element) => element.scrollHeight <= element.clientHeight),
        ).toBe(true);

        await thread.hover();
        await page.mouse.wheel(0, -100);
        await expect
          .poll(async () =>
            (await gateway.getRequests("chat.history")).map(
              (request) => (request.params as { offset?: number } | undefined)?.offset,
            ),
          )
          .toEqual([2, 6]);
        const showEarlier = await expectHistoryBoundaryState(pane, true);
        expect(
          await thread.evaluate((element) => element.scrollHeight <= element.clientHeight),
        ).toBe(true);
        if (artifactDir) {
          await writeFile(
            path.join(artifactDir, "01-native-history-prefetch-held.png"),
            await takeControlUiViewportScreenshot(page, pane.locator(".chat-main"), [showEarlier]),
          );
        }

        await gateway.resolveDeferred("chat.history");
        await expect
          .poll(() => thread.evaluate((element) => element.scrollHeight > element.clientHeight))
          .toBe(true);
        await expect
          .poll(() => pane.locator('.chat-history-boundary__action[aria-busy="true"]').count())
          .toBe(0);
        await pane.locator(".chat-history-sentinel").waitFor({ state: "detached" });
        if (artifactDir) {
          await writeFile(
            path.join(artifactDir, "02-native-history-final-scrollable.png"),
            await takeControlUiViewportScreenshot(page, pane.locator(".chat-main"), [thread]),
          );
        }
        // Exhausting history also stops reader prefetch.
        await expect
          .poll(() => gateway.getRequests("chat.history").then((requests) => requests.length))
          .toBe(2);
        expect(
          (await gateway.getRequests("chat.history")).map(
            (request) => (request.params as { offset?: number } | undefined)?.offset,
          ),
        ).toEqual([2, 6]);
        for (const request of await gateway.getRequests("chat.history")) {
          expect(request.params).toMatchObject({ limit: 1000, maxBytes: 1024 * 1024 });
        }
      } finally {
        await suite.closeBrowserContext(context);
        if (artifactDir && proofVideo) {
          await proofVideo.saveAs(path.join(artifactDir, "native-history-autofill.webm"));
        }
      }
    },
  );
});
