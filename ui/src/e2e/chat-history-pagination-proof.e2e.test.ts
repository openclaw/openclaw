// Control UI browser proof for delayed older-history pages and deep scroll.
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describePaginationProof =
  chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

const TOTAL_MESSAGES = 2_200;
const FIRST_PAGE_COUNT = 2_050;
const OLDER_PAGE_COUNT = TOTAL_MESSAGES - FIRST_PAGE_COUNT;
const HARD_CAP = 2_000;
const DELAYED_PAGE_MS = 1_000;

const artifactDir = path.resolve(
  process.env.OPENCLAW_CHAT_HISTORY_PAGINATION_PROOF_OUTPUT_DIR ??
    path.join(process.cwd(), ".artifacts", "control-ui-e2e", "chat-history-pagination-proof"),
);

let server: ControlUiE2eServer;
const contextBrowsers = new WeakMap<BrowserContext, Browser>();

function buildTranscript(total: number) {
  return Array.from({ length: total }, (_, index) => ({
    content: [{ text: `msg-${index}`, type: "text" as const }],
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    timestamp: index + 1,
  }));
}

function historyPagePayload(params: {
  hasMore: boolean;
  messages: ReturnType<typeof buildTranscript>;
  nextOffset?: number;
  offset: number;
  totalMessages: number;
}) {
  return {
    hasMore: params.hasMore,
    messages: params.messages,
    offset: params.offset,
    sessionId: "control-ui-e2e-session",
    thinkingLevel: null,
    totalMessages: params.totalMessages,
    ...(params.nextOffset != null ? { nextOffset: params.nextOffset } : {}),
  };
}

async function newBrowserContext(options: Parameters<Browser["newContext"]>[0]) {
  const browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  try {
    const context = await browser.newContext(options);
    contextBrowsers.set(context, browser);
    return context;
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

async function closeBrowserContext(context: BrowserContext): Promise<void> {
  const browser = contextBrowsers.get(context);
  contextBrowsers.delete(context);
  await context.close().catch(() => {});
  await browser?.close().catch(() => {});
}

async function scrollChatThreadToTop(page: Page) {
  await page.locator(".chat-thread").evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

async function expandLocalRenderWindow(page: Page, times: number) {
  for (let index = 0; index < times; index += 1) {
    await scrollChatThreadToTop(page);
    await page.waitForTimeout(30);
  }
}

async function waitForNewHistoryOffset(
  gateway: MockGatewayControls,
  offset: number,
  previousCount: number,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const requests = await gateway.getRequests("chat.history");
    if (requests.length > previousCount) {
      const latest = requests[requests.length - 1];
      const params = latest?.params;
      const latestOffset =
        params && typeof params === "object" && !Array.isArray(params)
          ? (params as { offset?: unknown }).offset
          : undefined;
      if (latestOffset === offset) {
        return latest;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for new chat.history offset=${offset} after ${previousCount} requests`,
  );
}

describePaginationProof("Control UI chat history pagination browser proof", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a compatible browser, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    await mkdir(artifactDir, { recursive: true });
    server = await startControlUiE2eServer();
  });

  afterAll(async () => {
    await server?.close();
  });

  it("keeps the viewport stable across a delayed older page and reaches past the hard cap", async () => {
    const rawVideoDir = path.join(artifactDir, "raw-video");
    await mkdir(rawVideoDir, { recursive: true });
    const context = await newBrowserContext({
      locale: "en-US",
      recordVideo: { dir: rawVideoDir, size: { height: 900, width: 1280 } },
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const transcript = buildTranscript(TOTAL_MESSAGES);
    const newestPage = transcript.slice(OLDER_PAGE_COUNT);
    const olderPage = transcript.slice(0, OLDER_PAGE_COUNT);
    const firstPage = historyPagePayload({
      hasMore: true,
      messages: newestPage,
      nextOffset: FIRST_PAGE_COUNT,
      offset: 0,
      totalMessages: TOTAL_MESSAGES,
    });
    const gateway = await installMockGateway(page, {
      historyMessages: transcript,
      methodResponses: {
        "chat.history": {
          cases: [
            {
              match: { offset: 0 },
              response: firstPage,
            },
            {
              match: { offset: FIRST_PAGE_COUNT },
              response: historyPagePayload({
                hasMore: false,
                messages: olderPage,
                offset: FIRST_PAGE_COUNT,
                totalMessages: TOTAL_MESSAGES,
              }),
            },
          ],
        },
        "chat.startup": {
          ...firstPage,
          agentsList: {
            agents: [
              {
                id: "main",
                identity: { name: "OpenClaw" },
                name: "OpenClaw",
                workspaceGit: false,
              },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          metadata: {
            models: [{ id: "gpt-5.5", name: "gpt-5.5", provider: "openai" }],
          },
        },
      },
    });
    const startedAt = new Date().toISOString();

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.getByText(`msg-${TOTAL_MESSAGES - 1}`).waitFor({ timeout: 30_000 });
      await page.screenshot({
        path: path.join(artifactDir, "01-newest-page.png"),
        fullPage: true,
      });

      // Exhaust the local render window until the delayed older-page request fires.
      const historyCountBefore = (await gateway.getRequests("chat.history")).length;
      await gateway.deferNext("chat.history");
      let requestedOlder = false;
      for (let attempt = 0; attempt < 90; attempt += 1) {
        await scrollChatThreadToTop(page);
        try {
          await waitForNewHistoryOffset(gateway, FIRST_PAGE_COUNT, historyCountBefore, 150);
          requestedOlder = true;
          break;
        } catch {
          // Keep expanding until the gateway older page is requested.
        }
      }
      if (!requestedOlder) {
        await waitForNewHistoryOffset(gateway, FIRST_PAGE_COUNT, historyCountBefore);
      }

      const thread = page.locator(".chat-thread");
      const scrollTopBeforeResolve = await thread.evaluate((element) => element.scrollTop);
      await page.screenshot({
        path: path.join(artifactDir, "02-waiting-delayed-older-page.png"),
        fullPage: true,
      });

      await page.waitForTimeout(DELAYED_PAGE_MS);
      await gateway.resolveDeferred("chat.history");
      await page.getByText("msg-0").waitFor({ timeout: 30_000 });

      // Viewport should remain near the pre-fetch anchor after the delayed prepend.
      const scrollTopAfterResolve = await thread.evaluate((element) => element.scrollTop);
      expect(scrollTopAfterResolve).toBeGreaterThanOrEqual(scrollTopBeforeResolve);

      await page.screenshot({
        path: path.join(artifactDir, "03-after-delayed-older-page.png"),
        fullPage: true,
      });

      // Slide the bounded DOM window through the >2,000 loaded messages.
      await expandLocalRenderWindow(page, 20);
      await page.getByText("msg-0").waitFor({ timeout: 20_000 });
      await page.getByText(/Showing 2000 messages/).waitFor({ timeout: 10_000 });
      expect(await page.getByText(`msg-${TOTAL_MESSAGES - 1}`).count()).toBe(0);

      await page.screenshot({
        path: path.join(artifactDir, "04-deep-scroll-past-hard-cap.png"),
        fullPage: true,
      });

      const historyRequests = await gateway.getRequests("chat.history");
      const olderRequests = historyRequests.filter((request) => {
        const params = request.params;
        return (
          params &&
          typeof params === "object" &&
          !Array.isArray(params) &&
          (params as { offset?: unknown }).offset === FIRST_PAGE_COUNT
        );
      });
      expect(olderRequests).toHaveLength(1);
      expect(FIRST_PAGE_COUNT).toBeGreaterThan(HARD_CAP);

      await writeFile(
        path.join(artifactDir, "chat-history-pagination-proof.json"),
        `${JSON.stringify(
          {
            delayedOlderPageMs: DELAYED_PAGE_MS,
            finishedAt: new Date().toISOString(),
            firstPageCount: FIRST_PAGE_COUNT,
            hardCap: HARD_CAP,
            olderPageCount: OLDER_PAGE_COUNT,
            olderPageOffset: FIRST_PAGE_COUNT,
            redacted: true,
            scrollTopAfterResolve,
            scrollTopBeforeResolve,
            startedAt,
            status: "pass",
            totalMessages: TOTAL_MESSAGES,
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      const video = page.video();
      await closeBrowserContext(context);
      const videoPath = await video?.path().catch(() => undefined);
      if (videoPath) {
        await copyFile(videoPath, path.join(artifactDir, "chat-history-pagination-proof.webm"));
      }
    }
  }, 180_000);
});
