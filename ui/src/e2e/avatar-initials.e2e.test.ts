// Control UI proof: agent chip avatar fallbacks keep complete graphemes for
// flag/ZWJ emoji and ordinary Unicode letters (no UTF-16 mid-cluster cuts).
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

const artifactDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "avatar-initials");

const CASES = [
  { assistantName: "🇺🇸Team", expectedInitial: "🇺🇸", shot: "flag-avatar.png" },
  { assistantName: "👨‍💻Dev", expectedInitial: "👨‍💻", shot: "zwj-avatar.png" },
  { assistantName: "東京", expectedInitial: "東", shot: "tokyo-avatar.png" },
] as const;

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI avatar grapheme initials E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    await mkdir(artifactDir, { recursive: true });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("renders complete flag, ZWJ, and Unicode letter initials in the agent chip", async () => {
    const proof: Record<string, string> = {};

    for (const testCase of CASES) {
      const context = await browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      });
      const page = await context.newPage();
      await installMockGateway(page, { assistantName: testCase.assistantName });

      try {
        const response = await page.goto(server.baseUrl);
        expect(response?.status()).toBe(200);

        const avatar = page.locator(".sidebar-agent-card__avatar-text");
        await avatar.waitFor();
        await expect.poll(() => avatar.textContent()).toBe(testCase.expectedInitial);
        proof[testCase.shot] = (await avatar.textContent()) ?? "";

        await page.locator(".sidebar-agent-card").screenshot({
          path: path.join(artifactDir, testCase.shot),
        });
      } finally {
        await context.close();
      }
    }

    console.log("control-ui avatar-initials e2e proof:", JSON.stringify(proof));
    console.log("control-ui avatar-initials artifact dir:", artifactDir);
  });
});
