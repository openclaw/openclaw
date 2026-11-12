import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  PUBLIC_SESSION_CONTENT_SECURITY_POLICY,
  renderPublicSessionDocument,
} from "../../../src/gateway/control-ui-public-session-render.ts";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";

const wideTable = [
  "| Service | Owner | Region | Status | Version | Deployment | Source | Notes | Commit | Checks | Evidence | Updated |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  "| Gateway integration | Platform review team | eu-west-1 | Healthy | 2026.11.3 | Ready for human review | Retained current-source evidence | Controls remain readable alongside the original context. | ab12345 | Complete | Retained | Today |",
  "| Reader interface | Documentation reviewers | us-east-1 | Follow-up recorded | Current source | Verification retained | Canonical report and artifact references | A deliberately wider column demonstrates contained table scrolling. | cd67890 | Pending | Linked | Today |",
  "| Public conversation | Synthetic fixture owner | ap-southeast-2 | Read-only | Current renderer | No publication performed | Local-only HTTP fixture | No live conversation is shared. | ef24680 | Reviewed | Local | Today |",
].join("\n");
const longUrl = "https://example.test/" + "evidence".repeat(40);
const fixtures = {
  wide:
    "## Release review\n\nEvery entry is synthetic. Keep the source and the result together.\n\n" +
    wideTable +
    "\n\n### Read-only verification\n\nThe table remains part of the public conversation.",
  siblings: [
    "## Short comparison",
    "| Item | State |\n| --- | --- |\n| Reader | Ready |\n| Gateway | Healthy |",
    "## Detailed notes",
    "| Item | Notes |\n| --- | --- |\n| Review | " +
      "Useful longer notes wrap at natural word boundaries. ".repeat(12) +
      " |\n| Evidence | " +
      longUrl +
      " |",
    "## Paragraph containment",
    longUrl,
  ].join("\n\n"),
};
const modes = [
  { width: 388, height: 844 },
  { width: 1280, height: 900 },
].flatMap((viewport) =>
  (["light", "dark"] as const).map((colorScheme) => ({ viewport, colorScheme })),
);
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const { wsEndpoint, executablePath } = inject("controlUiE2eChromium");

// Real server-rendered Markdown over HTTP, including its stylesheet, fonts and
// CSP. No operator app/build, authenticated data or replacement HTML/CSS is needed.
describe("public-reader table readability", () => {
  let browser: Browser;
  let listener: Awaited<ReturnType<typeof reserveTestPortListener<Server>>>;
  let baseUrl: string;
  let artifact: string | undefined;

  beforeAll(async () => {
    browser = wsEndpoint
      ? await chromium.connect(wsEndpoint)
      : await chromium.launch({ executablePath });
    listener = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((req, res) => {
          const url = new URL(req.url ?? "/", "http://localhost");
          const font = url.pathname.match(
            /^\/fonts\/(instrument-sans(?:-[a-z-]+)?\.(?:css|woff2))$/u,
          );
          if (font?.[1]) {
            res.setHeader("Content-Type", font[1].endsWith(".css") ? "text/css" : "font/woff2");
            res.end(readFileSync(path.resolve("ui/public/fonts", font[1])));
            return;
          }
          const body =
            url.pathname === "/wide"
              ? fixtures.wide
              : url.pathname === "/siblings"
                ? fixtures.siblings
                : undefined;
          if (!body) {
            res.writeHead(404).end();
            return;
          }
          const html = renderPublicSessionDocument({
            title: "Synthetic release review",
            assetBasePath: "",
            latestUrl: url.pathname,
            cardUrl: "/synthetic-card.png",
            truncated: false,
            isLatest: false,
            messages: [
              { role: "user", content: "Review the synthetic service comparison." },
              { role: url.searchParams.has("user") ? "user" : "assistant", content: body },
            ],
          });
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader("Content-Security-Policy", PUBLIC_SESSION_CONTENT_SECURITY_POLICY);
          res.end(html);
        }),
    });
    baseUrl = "http://127.0.0.1:" + listener.claim.port;
    if (capture) {
      artifact = createControlUiE2eArtifactDir("public-table");
    }
  });

  async function captureFrame(page: Page, content: Locator, name: string, metrics: unknown) {
    if (!artifact) {
      return;
    }
    const frame = await takeControlUiScreenshotFrame(page, page.locator("main"), [content], {
      animations: "disabled",
    });
    writeFileSync(path.join(artifact, name + ".png"), frame.png);
    writeFileSync(
      path.join(artifact, name + ".json"),
      JSON.stringify(
        { metrics, sha256: createHash("sha256").update(frame.png).digest("hex") },
        null,
        2,
      ),
    );
  }

  afterAll(async () => {
    await browser?.close();
    if (listener) {
      await listener.releaseListener();
      await listener.claim.release();
    }
  });

  it("preserves ordinary words in a many-column table and lets readers reach its end", async () => {
    for (const mode of modes) {
      const context = await browser.newContext({ ...mode, reducedMotion: "reduce" });
      try {
        const page = await context.newPage();
        const response = await page.goto(baseUrl + "/wide");
        expect(response?.status()).toBe(200);
        await page.evaluate(() => document.fonts.ready);
        const table = page.getByRole("table");
        const first = table.getByRole("columnheader", { name: "Service", exact: true });
        await page.evaluate(() =>
          window.scrollTo(
            0,
            document.querySelector("table")!.getBoundingClientRect().top + scrollY - 180,
          ),
        );
        const metrics = await table.evaluate((element) => {
          const headers = [...element.querySelectorAll("th")];
          return {
            height: element.getBoundingClientRect().height,
            headers: headers.map((cell) => {
              const range = document.createRange();
              range.selectNodeContents(cell);
              return {
                text: cell.textContent,
                height: range.getBoundingClientRect().height,
                line: Number.parseFloat(getComputedStyle(cell).lineHeight),
              };
            }),
            documentOverflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        const name = mode.viewport.width + "-" + mode.colorScheme;
        await captureFrame(page, first, name, metrics);
        expect.soft(metrics.documentOverflow).toBe(false);
        for (const header of metrics.headers) {
          expect.soft(header.height, header.text ?? "header").toBeLessThanOrEqual(header.line);
        }
        expect.soft(metrics.height).toBeLessThan(400);
        expect(await table.getByRole("columnheader").count()).toBe(12);
        const viewport = page.locator(".content .table");
        await table.focus();
        await page.keyboard.press("ArrowRight");
        await expect.poll(() => viewport.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
        await first.hover();
        await page.mouse.wheel(10000, 0);
        const last = table.getByRole("columnheader", { name: "Updated", exact: true });
        await expect
          .poll(() => last.evaluate((el) => el.getBoundingClientRect().right <= innerWidth))
          .toBe(true);
        await captureFrame(
          page,
          last,
          name + "-right",
          await viewport.evaluate((el) => ({
            client: el.clientWidth,
            scroll: el.scrollWidth,
            left: el.scrollLeft,
          })),
        );
        expect(await last.isVisible()).toBe(true);
        expect(
          await last.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.left >= 0 && r.right <= innerWidth;
          }),
        ).toBe(true);
        expect(await page.locator("openclaw-app").count()).toBe(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      } finally {
        await context.close();
      }
    }
  });

  it("keeps short tables compact and wraps long cell text without widening the document", async () => {
    for (const mode of modes) {
      const context = await browser.newContext(mode);
      try {
        const page = await context.newPage();
        await page.goto(baseUrl + "/siblings");
        await page.evaluate(() => document.fonts.ready);
        const short = page.getByRole("table").nth(0);
        const long = page.getByRole("table").nth(1);
        expect(await short.evaluate((el) => el.getBoundingClientRect().width)).toBeLessThan(250);
        const notes = long.getByRole("cell").filter({ hasText: "Useful longer notes" });
        const dimensions = await notes.evaluate((el) => ({
          width: el.getBoundingClientRect().width,
          height: el.getBoundingClientRect().height,
          line: Number.parseFloat(getComputedStyle(el).lineHeight),
        }));
        expect(dimensions.width).toBeLessThanOrEqual(410);
        expect(dimensions.height).toBeGreaterThan(dimensions.line * 2);
        expect(
          await long
            .getByRole("cell", { name: longUrl, exact: true })
            .evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.evaluate(() =>
          window.scrollTo(
            0,
            document.querySelector("table")!.getBoundingClientRect().top + scrollY - 80,
          ),
        );
        await captureFrame(
          page,
          short.getByRole("columnheader").first(),
          mode.viewport.width + "-" + mode.colorScheme + "-siblings",
          dimensions,
        );
        await page.goto(baseUrl + "/siblings?user");
        expect(await page.locator(".user table").count()).toBe(2);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      } finally {
        await context.close();
      }
    }
  });
});
