import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { expect } from "vitest";
import {
  gateway,
  patchProofConfig,
} from "../src/gateway/gateway.sessions-send-provenance.test-support.js";
import { createControlUiE2eArtifactDir } from "../ui/src/test-helpers/control-ui-e2e-artifacts.js";
import { evaluateControlUiContext } from "../ui/src/test-helpers/control-ui-e2e-context.js";
import { waitForControlUiGatewayReady } from "../ui/src/test-helpers/control-ui-e2e-readiness.js";
import { takeControlUiScreenshotFrame } from "../ui/src/test-helpers/control-ui-e2e-screenshot.js";
import {
  controlUiSessionUrl,
  startBundledControlUiE2eServer,
  startBuiltControlUiE2eServer,
} from "../ui/src/test-helpers/control-ui-e2e.js";

/** Optional retained proof through real RPCs and avatar HTTP, never a mocked Gateway. */
export async function startLinkedAuthorBrowserProof(
  profileId: string,
  sessionKey: string,
  messageId: string,
) {
  const dir = createControlUiE2eArtifactDir("linked-author-real-gateway");
  const retainedBuild = process.env.OPENCLAW_UI_E2E_PRODUCTION_ARTIFACT_ROOT;
  const ui = retainedBuild
    ? await startBuiltControlUiE2eServer(retainedBuild)
    : await startBundledControlUiE2eServer(path.join(dir, "ui"));
  const browser = await chromium.launch().catch(async (error: unknown) => {
    await ui.close();
    throw error;
  });
  try {
    await gateway.client.request("users.setDisplayName", { profileId, displayName: "Alex" });
    await gateway.client.request("users.setAvatar", {
      profileId,
      mime: "image/png",
      avatarBase64: (await fs.readFile(path.resolve("ui/public/apple-touch-icon.png"))).toString(
        "base64",
      ),
    });
    await patchProofConfig({
      gateway: { controlUi: { allowedOrigins: [new URL(ui.baseUrl).origin] } },
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      serviceWorkers: "block",
    });
    const target = new URL(controlUiSessionUrl(ui.baseUrl, sessionKey));
    const gatewayUrl = new URL(`ws://127.0.0.1:${gateway.port}`);
    target.hash = new URLSearchParams({
      gatewayUrl: gatewayUrl.href,
      token: process.env.OPENCLAW_GATEWAY_TOKEN ?? "",
    }).toString();
    await page.goto(target.href, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: `Switch to ${gatewayUrl.host}`, exact: true }).click();
    // Observe the normal loopback token/device admission; do not race its
    // automatic local pairing by approving an already-consumed request.
    await waitForControlUiGatewayReady(page, 30_000);
    const row = page.locator(`.chat-group.user:has([data-entry-id="${messageId}"])`);
    const receipts: Array<{ stage: string; linked: boolean; historyRead: true }> = [];
    return {
      async capture(stage: string, linked: boolean) {
        await page.reload({ waitUntil: "domcontentloaded" });
        await waitForControlUiGatewayReady(page, 30_000);
        await row.waitFor();
        const browserMetadata = await evaluateControlUiContext(
          page,
          async (app, request) => {
            const client = app.gateway.snapshot.client;
            if (!client) {
              throw new Error("Real Gateway browser client missing");
            }
            const response = await client.request<{
              messages: Array<{ __openclaw?: Record<string, unknown> }>;
            }>("chat.history", { sessionKey: request.sessionKey, limit: 20 });
            return response.messages.find(
              (message) => message["__openclaw"]?.id === request.messageId,
            )?.["__openclaw"];
          },
          { sessionKey, messageId },
        );
        expect(browserMetadata?.id).toBe(messageId);
        expect(browserMetadata?.senderDisplayProfileId).toBe(linked ? profileId : undefined);
        expect(browserMetadata).not.toHaveProperty("requesterOrigin");
        if (linked) {
          await row.locator(".chat-message-source").filter({ hasText: "Telegram" }).waitFor();
          await expect
            .poll(() =>
              row
                .locator(".chat-avatar-slot img")
                .evaluate((image: HTMLImageElement) => image.naturalWidth),
            )
            .toBeGreaterThan(0);
          expect(await row.locator(".chat-sender-name").textContent()).toBe("Alex");
        } else {
          await expect.poll(() => row.locator(".chat-avatar-slot img").count()).toBe(0);
          expect(await row.locator(".chat-sender-name").textContent()).toBe("Linked sender");
        }
        const frame = await takeControlUiScreenshotFrame(page, page.locator("body"), [row], {
          animations: "disabled",
        });
        await fs.writeFile(path.join(dir, `${stage}.png`), frame.png);
        receipts.push({ stage, linked, historyRead: true });
        await fs.writeFile(
          path.join(dir, "receipts.json"),
          JSON.stringify(
            {
              transport:
                "Real Gateway RPC and profile-avatar HTTP; built Control UI; synthetic provider and channel ingress; Shared Owner observer, not the linked person",
              receipts,
            },
            null,
            2,
          ),
        );
        console.log(`Real Gateway linked-author proof: ${path.join(dir, stage + ".png")}`);
      },
      async close() {
        try {
          await browser.close();
        } finally {
          await ui.close();
        }
      },
    };
  } catch (error) {
    try {
      await browser.close();
    } finally {
      await ui.close();
    }
    throw error;
  }
}
