// Control UI proves the generic system-agent QR wizard step through a mocked Gateway.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import qrcode from "qrcode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(executablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "custodian-qr-code");

let browser: Browser;
let server: ControlUiE2eServer;

describeE2e("Custodian QR wizard step", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("advertises, renders, and acknowledges the shared QR step", async () => {
    const qrDataUrl = await qrcode.toDataURL("https://openclaw.ai/qr-proof", {
      margin: 2,
      width: 560,
    });
    const qrResponse = {
      sessionId: "e2e-system-agent-qr",
      reply: "Scan this code to continue setup.",
      action: "none",
      wizardInputPending: true,
      step: {
        id: "setup-qr",
        type: "qr",
        title: "Link Signal",
        message: "Scan the code, then continue.",
        qrDataUrl,
        expiresInMs: 30 * 60 * 1000,
        executor: "client",
      },
    };
    if (captureProof) {
      await mkdir(proofDir, { recursive: true });
    }
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 844, width: 390 },
      ...(captureProof
        ? { recordVideo: { dir: proofDir, size: { height: 844, width: 390 } } }
        : {}),
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "openclaw.chat"],
      methodResponses: {
        "openclaw.chat": {
          cases: [
            {
              match: { wizardAnswer: { stepId: "setup-qr", value: true } },
              response: {
                sessionId: "e2e-system-agent-qr",
                reply: "Signal is configured.",
                action: "none",
              },
            },
            { match: { pollStepId: "setup-qr" }, response: qrResponse },
            { response: qrResponse },
          ],
        },
      },
    });

    try {
      expect(
        (
          await page.goto(`${server.baseUrl}custodian?onboarding=1`, {
            timeout: 60_000,
            waitUntil: "domcontentloaded",
          })
        )?.status(),
      ).toBe(200);
      const image = page.getByAltText("QR code for setup");
      await image.waitFor();

      expect(await image.getAttribute("src")).toBe(qrDataUrl);
      await expect
        .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
        .toBeGreaterThan(0);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);

      if (captureProof) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(proofDir, "qr-step.png"),
        });
      }

      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByText("Signal is configured.").waitFor();
      const requests = await gateway.getRequests("openclaw.chat");
      expect(requests.at(-1)?.params).toMatchObject({
        sessionId: "e2e-system-agent-qr",
        wizardAnswer: { stepId: "setup-qr", value: true },
      });
      expect(await image.count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
