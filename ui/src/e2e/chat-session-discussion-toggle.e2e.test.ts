import path from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { beforeEach, afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  controlUiSessionUrl,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { activateChatHeaderPanelAction } from "./chat-side-panel.test-support.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("session-discussion-toggle");
  }
});

let server: ControlUiE2eServer;
let browser: Browser;
const openContexts = new Set<BrowserContext>();

async function closeOpenContexts(): Promise<void> {
  const contexts = Array.from(openContexts);
  openContexts.clear();
  await Promise.all(contexts.map((context) => context.close()));
}

describeControlUiE2e("session discussion toggle", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    server = await startControlUiE2eServer();
  });

  afterEach(closeOpenContexts);

  afterAll(async () => {
    await closeOpenContexts();
    await browser?.close();
    await server?.close();
  });

  it("keeps an existing discussion closed until the header action opens it", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      ...(captureUiProof
        ? { recordVideo: { dir: proofDir, size: { height: 720, width: 1280 } } }
        : {}),
      viewport: { height: 720, width: 1280 },
    });
    openContexts.add(context);
    const page = await context.newPage();
    const sessionKey = "agent:main:discussion-proof";
    await page.route("https://discussion.example/embed/channel/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html><head><style>
          html,body{margin:0;height:100%;background:#0e1015;color:#e6e8ed;font:14px system-ui}
          main{height:100%;display:flex;flex-direction:column}
          header,footer{padding:15px;border-bottom:1px solid #292d36}
          footer{border-top:1px solid #292d36;border-bottom:0;color:#858b9b}
          section{flex:1;padding:20px;display:grid;align-content:start;gap:14px}
          article{padding:12px;border:1px solid #303541;border-radius:9px}
          </style></head><body><main><header>Discussion is ready</header>
          <section><article>Discussion toggle proof.</article>
          <article>Replies appear here when the room is open.</article></section>
          <footer>Message #discussion</footer></main></body></html>`,
      }),
    );
    const gateway = await installMockGateway(page, {
      featureMethods: ["session.discussion.info", "session.discussion.open"],
      historyMessages: [
        {
          content: [{ type: "text", text: "Discussion toggle proof." }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
      methodResponses: {
        "session.discussion.info": {
          embedUrl: "https://discussion.example/embed/channel/T1/C1?openclawHostTheme=1",
          openUrl: "https://discussion.example/session",
          state: "open",
        },
        "session.discussion.open": {
          openUrl: "https://discussion.example/session",
          state: "open",
        },
      },
      sessionKey,
    });

    await page.goto(controlUiSessionUrl(server.baseUrl, sessionKey));
    await gateway.waitForRequest("session.discussion.info");

    // An existing discussion stays closed until the operator asks for it, and
    // showing it must never re-open the discussion on the gateway.
    const discussionPanel = page.locator('.side-panel__panel[data-panel-slot="discussion"]');
    const closeDiscussion = page.getByRole("button", { name: "Close Discussion" });
    await expect.poll(() => discussionPanel.count()).toBe(0);
    if (captureUiProof) {
      await page.screenshot({ path: path.join(proofDir, "discussion-initial-closed.png") });
    }

    // The availability probe already resolved this room. A second provider
    // read may stall; opening a known room must not wait on that read again.
    await gateway.deferNext("session.discussion.info", { sessionKey });
    await page.evaluate(() => {
      const started = performance.now();
      const observer = new MutationObserver(() => {
        if (document.querySelector("iframe.session-discussion__frame")) {
          (window as Window & { discussionMountMs?: number }).discussionMountMs =
            performance.now() - started;
          observer.disconnect();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    await activateChatHeaderPanelAction(page, "Show discussion");

    await expect.poll(() => discussionPanel.count()).toBe(1);
    await expect.poll(() => closeDiscussion.isVisible()).toBe(true);
    const frame = page.frameLocator("iframe.session-discussion__frame");
    await expect.poll(() => frame.getByText("Discussion is ready").isVisible()).toBe(true);
    const mountMs = await page.evaluate(
      () => (window as Window & { discussionMountMs?: number }).discussionMountMs,
    );
    expect(mountMs).toBeDefined();
    expect(mountMs!).toBeLessThan(1_000);
    console.info("Discussion frame mounted in", mountMs, "ms");
    expect(await gateway.getRequests("session.discussion.info")).toHaveLength(1);
    expect(await gateway.getRequests("session.discussion.open")).toHaveLength(0);
    if (captureUiProof) {
      await page.screenshot({ path: path.join(proofDir, "discussion-open.png") });
    }

    await activateChatHeaderPanelAction(page, "Hide discussion");

    await expect.poll(() => closeDiscussion.isVisible()).toBe(false);
    await expect.poll(() => discussionPanel.count()).toBe(0);
    expect(await gateway.getRequests("session.discussion.open")).toHaveLength(0);
    if (captureUiProof) {
      await page.screenshot({ path: path.join(proofDir, "discussion-closed.png") });
    }
  });

  it("keeps a cross-origin discussion in sync when the real host color scheme changes", async () => {
    const context = await browser.newContext({
      colorScheme: "light",
      ...(captureUiProof
        ? { recordVideo: { dir: proofDir, size: { height: 720, width: 1280 } } }
        : {}),
      viewport: { height: 720, width: 1280 },
    });
    openContexts.add(context);
    const page = await context.newPage();
    const sessionKey = "agent:main:discussion-theme-proof";

    await page.route("https://discussion.example/embed/channel/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html><head><meta charset="utf-8">
          <style>
            :root { font: 14px system-ui, sans-serif; }
            body { margin: 0; padding: 20px; background: var(--host-surface, #fff);
              color: var(--host-text, #18181b); }
            article { padding: 16px; border: 1px solid var(--host-border, #e4e4e7);
              border-radius: 8px; background: var(--host-card, #fff); }
          </style></head><body><article><h2>Cross-origin discussion</h2>
          <p>The sidebar follows its OpenClaw host.</p></article>
          <script>
            const params = new URLSearchParams(location.search);
            document.documentElement.dataset.hostMode = params.get("theme") || "dark";
            window.addEventListener("message", (event) => {
              if (event.source !== parent || event.origin !== params.get("hostOrigin")) return;
              if (event.data?.type !== "openclaw:widget-theme") return;
              document.documentElement.dataset.hostMode = event.data.mode;
              for (const [token, value] of Object.entries(event.data.tokens || {})) {
                if (typeof value === "string") {
                  document.documentElement.style.setProperty("--host-" + token, value);
                }
              }
            });
          </script></body></html>`,
      }),
    );

    const gateway = await installMockGateway(page, {
      featureMethods: ["session.discussion.info", "session.discussion.open"],
      historyMessages: [
        {
          content: [{ type: "text", text: "Cross-origin theme proof." }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
      methodResponses: {
        "session.discussion.info": { state: "available" },
        "session.discussion.open": {
          embedUrl: "https://discussion.example/embed/channel/T1/C1?openclawHostTheme=1",
          openUrl: "https://discussion.example/app/T1/C1",
          state: "open",
        },
      },
      sessionKey,
    });

    await page.goto(controlUiSessionUrl(server.baseUrl, sessionKey));
    await gateway.waitForRequest("session.discussion.info");
    await activateChatHeaderPanelAction(page, "Show discussion");

    const frameElement = page.locator("iframe.session-discussion__frame");
    await expect.poll(() => frameElement.count()).toBe(1);
    await expect
      .poll(() =>
        page
          .frames()
          .some((candidate) =>
            candidate.url().startsWith("https://discussion.example/embed/channel/"),
          ),
      )
      .toBe(true);
    const frame = page
      .frames()
      .find((candidate) => candidate.url().startsWith("https://discussion.example/embed/channel/"));
    expect(frame).toBeDefined();

    const frameUrl = new URL(frame!.url());
    expect(frameUrl.searchParams.get("theme")).toBe("light");
    expect(frameUrl.searchParams.get("hostOrigin")).toBe(new URL(server.baseUrl).origin);
    await expect.poll(() => frame!.locator("html").getAttribute("data-host-mode")).toBe("light");
    await expect
      .poll(() =>
        frame!.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--host-surface").trim(),
        ),
      )
      .not.toBe("");
    if (captureUiProof) {
      await page.screenshot({ path: path.join(proofDir, "discussion-theme-light.png") });
    }

    await page.emulateMedia({ colorScheme: "dark" });

    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.themeMode))
      .toBe("dark");
    await expect.poll(() => frame!.locator("html").getAttribute("data-host-mode")).toBe("dark");
    await expect
      .poll(async () => {
        const [hostSurface, embeddedSurface] = await Promise.all([
          page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
          ),
          frame!.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue("--host-surface").trim(),
          ),
        ]);
        return { hostSurface, embeddedSurface };
      })
      .toEqual({ hostSurface: "#0e1015", embeddedSurface: "#0e1015" });
    expect(new URL(frame!.url()).searchParams.get("theme")).toBe("light");
    if (captureUiProof) {
      await page.screenshot({ path: path.join(proofDir, "discussion-theme-dark.png") });
    }
  });
});
