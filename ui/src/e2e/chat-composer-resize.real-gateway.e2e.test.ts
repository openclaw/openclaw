// Chat composer resize grips through a real Gateway: the height grip
// persists per-device, the width grip commits through the Message width
// setting (single owner), and both survive reload.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { appendTranscriptMessage } from "../../../src/config/sessions/session-accessor.js";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  controlUiSessionUrl,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const COMPOSER_HEIGHT_STORAGE_KEY = "***";
const TOP_GRIP = ".agent-chat__composer-resize-top";
const SIDE_GRIP = ".agent-chat__composer-resize-side";
const COMPOSER_INPUT = ".agent-chat__input";
const COMPOSER_SHELL = ".agent-chat__composer-shell";
const COMPOSER_TEXTAREA = ".agent-chat__composer-combobox > textarea";
const MESSAGE_WIDTH_INPUT = "[data-settings-chat-message-width]";

const captureEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let instance: OpenClawTestInstance | undefined;
const suite = createControlUiE2eSuite({
  name: "Chat composer resize grips with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: "control-ui-composer-resize",
      config: {
        gateway: { controlUi: { enabled: true, root: path.resolve("dist/control-ui") } },
      },
    });
    instance = owner;
    try {
      // Seed a generic owner so no host account name enters the capture.
      ensureGatewayOwnerProfile("Resize Proof", { env: owner.env });
      await owner.startGateway();
      return { baseUrl: `http://127.0.0.1:${owner.port}/`, close: () => owner.cleanup() };
    } catch (error) {
      await runQaGatewayFixture(
        async () => {
          throw error;
        },
        () => owner.cleanup(),
      );
      throw error;
    }
  },
});

async function readWidthSetting(page: Page): Promise<string | null> {
  const value = await page.evaluate(() => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key) {
        continue;
      }
      try {
        const parsed = JSON.parse(localStorage.getItem(key) ?? "") as Record<string, unknown>;
        if (parsed && typeof parsed === "object" && "chatMessageMaxWidth" in parsed) {
          const width = parsed.chatMessageMaxWidth;
          return typeof width === "string" ? width : null;
        }
      } catch {
        // Non-JSON entries (tokens, flags) cannot own the width setting.
      }
    }
    return null;
  });
  return value;
}

function readColumnToken(page: Page): Promise<string> {
  return page
    .locator(COMPOSER_SHELL)
    .evaluate((element) =>
      getComputedStyle(element).getPropertyValue("--chat-thread-max-width").trim(),
    );
}

function readEditorMaxHeight(page: Page): Promise<string> {
  return page.locator(COMPOSER_TEXTAREA).evaluate((element) => getComputedStyle(element).maxHeight);
}

function px(value: string): number {
  const match = /^(\d+(?:\.\d+)?)px$/u.exec(value.trim());
  if (!match) {
    throw new Error(`Expected a px value, saw: ${value}`);
  }
  return Number(match[1]);
}

async function dragGrip(page: Page, selector: string, dx: number, dy: number): Promise<void> {
  const grip = page.locator(selector);
  await grip.scrollIntoViewIfNeeded();
  const box = await grip.boundingBox();
  expect(box, `${selector} has a hit box`).toBeTruthy();
  const startX = box!.x + box!.width / 2;
  const startY = box!.y + box!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY + dy, { steps: 12 });
  await page.mouse.up();
}

suite.define(() => {
  it.each(["chat", "new"])(
    "persists and resets composer resizing on /%s",
    async (route) => {
      if (!instance) {
        throw new Error("Gateway fixture is not running");
      }
      const owner = instance;
      const sessionKey = "agent:main:composer-resize-proof";
      const created = await owner.cli([
        "gateway",
        "call",
        "sessions.create",
        "--params",
        JSON.stringify({ key: sessionKey, agentId: "main", label: "Composer resize proof" }),
        "--json",
      ]);
      expect(created.code, created.stderr).toBe(0);
      const session = JSON.parse(created.stdout) as { ok: boolean; sessionId: string };
      expect(session.ok).toBe(true);
      for (const [role, text] of [
        ["user", "Show the composer resize grips proof thread."],
        ["assistant", "Resize grips proof thread ready."],
      ]) {
        await appendTranscriptMessage(
          { agentId: "main", sessionKey, sessionId: session.sessionId, env: owner.env },
          { message: { role, content: [{ type: "text", text }], timestamp: Date.now() } },
        );
      }
      // The Gateway serves Control UI assets asynchronously after start;
      // poll until the dashboard handoff reports ready (up to ~60s; the
      // checked-in dist is fresh so this normally passes on the first try).
      let dashboard = await owner.cli(["dashboard", "--json"]);
      const deadline = Date.now() + 60_000;
      while (dashboard.code !== 0 && Date.now() < deadline) {
        await new Promise((resolve) => {
          setTimeout(resolve, 3000);
        });
        dashboard = await owner.cli(["dashboard", "--json"]);
      }
      expect(
        dashboard.code,
        `dashboard --json failed: stdout=${dashboard.stdout} stderr=${dashboard.stderr}`,
      ).toBe(0);
      const issued = new URL((JSON.parse(dashboard.stdout) as { browserUrl: string }).browserUrl);

      // The dashboard handoff mints a one-time bootstrap grant: only the first
      // page load may carry the hash. Everything after navigates bare-URL in
      // the same browser context, proving the stored device grant carries
      // across chat/settings navigation and reloads the way an operator sees.
      const chatUrl = new URL(
        route === "chat"
          ? controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat")
          : `${suite.server.baseUrl}new`,
      );
      const chatUrlWithHash = new URL(chatUrl.toString());
      chatUrlWithHash.hash = issued.hash;
      const settingsUrl = new URL(`${suite.server.baseUrl}settings/appearance`);

      const artifactDir = createControlUiE2eArtifactDir(`composer-resize-${route}`);
      await suite.withPage(
        {
          locale: "en-US",
          viewport: { width: 1440, height: 1000 },
          serviceWorkers: "block",
          recordVideo: { dir: artifactDir, size: { width: 1440, height: 1000 } },
        },
        async ({ page }) => {
          await page.addInitScript(() => {
            localStorage.setItem(
              "openclaw:control-ui:community-invite",
              JSON.stringify({ dismissedAtMs: 1770000000000 }),
            );
          });
          expect((await page.goto(chatUrlWithHash.toString()))?.status()).toBe(200);
          await waitForControlUiGatewayReady(page);
          if (route === "chat") {
            await page.getByText("Resize grips proof thread ready.", { exact: true }).waitFor();
          }

          // Both grips mount on the composer input.
          await expect.poll(() => page.locator(TOP_GRIP).count(), { timeout: 10_000 }).toBe(1);
          await expect.poll(() => page.locator(SIDE_GRIP).count(), { timeout: 10_000 }).toBe(1);

          // Fresh preferences must resize and survive a new mount too.
          expect(await readWidthSetting(page)).toBeNull();
          const defaultWidthToken = await readColumnToken(page);
          const freshWidth = Math.round((await page.locator(COMPOSER_SHELL).boundingBox())!.width);
          await page.locator(COMPOSER_INPUT).hover();
          await dragGrip(page, SIDE_GRIP, -80, 0);
          await expect.poll(() => readWidthSetting(page)).toBe(`${freshWidth + 80}px`);
          await page.reload();
          await waitForControlUiGatewayReady(page);
          await expect.poll(() => readColumnToken(page)).toBe(`${freshWidth + 80}px`);
          await page.locator(COMPOSER_INPUT).hover();
          await page.locator(SIDE_GRIP).dblclick();
          await expect.poll(() => readWidthSetting(page)).toBeNull();

          // Establish an existing Message width preference through the
          // Settings page, the way an operator would.
          expect((await page.goto(settingsUrl.toString()))?.status()).toBe(200);
          await waitForControlUiSettingsTakeover(page);
          const widthInput = page.locator(MESSAGE_WIDTH_INPUT);
          await widthInput.waitFor();
          await widthInput.scrollIntoViewIfNeeded();
          await widthInput.fill("720px");
          await widthInput.blur();
          await expect.poll(() => readWidthSetting(page), { timeout: 10_000 }).toBe("720px");
          if (captureEnabled) {
            await page.screenshot({ path: path.join(artifactDir, "01-message-width-720.png") });
          }

          // The chat column renders the owned setting, not a grip override.
          expect((await page.goto(chatUrl.toString()))?.status()).toBe(200);
          await waitForControlUiGatewayReady(page);
          await expect.poll(() => readColumnToken(page), { timeout: 10_000 }).toBe("720px");

          // A click without movement is not a resize: the stored value
          // survives untouched instead of being rewritten as px (P1).
          await page.locator(COMPOSER_INPUT).hover();
          await page.locator(SIDE_GRIP).click();
          await page.waitForTimeout(500);
          expect(await readWidthSetting(page)).toBe("720px");
          expect(await readColumnToken(page)).toBe("720px");
          if (captureEnabled) {
            await page.screenshot({ path: path.join(artifactDir, "02-noop-click-keeps-720.png") });
          }

          // Dragging the side grip left widens the column AND updates the
          // single owned setting (P1: no competing persistence).
          await page.locator(COMPOSER_INPUT).hover();
          await dragGrip(page, SIDE_GRIP, -200, 0);
          await expect.poll(() => readWidthSetting(page), { timeout: 10_000 }).toBe("920px");
          await expect.poll(() => readColumnToken(page), { timeout: 10_000 }).toBe("920px");
          if (captureEnabled) {
            await page.screenshot({ path: path.join(artifactDir, "03-width-dragged-920.png") });
          }

          // Reload restores the dragged width from the setting (P2: the host
          // renders it; no pre-attachment grip restore needed).
          await page.reload();
          await waitForControlUiGatewayReady(page);
          await expect.poll(() => readColumnToken(page), { timeout: 10_000 }).toBe("920px");
          expect(await readWidthSetting(page)).toBe("920px");

          // Oversized pixel preference: store a cap wider than a narrowed
          // pane can show, then narrow-drag. The baseline comes from the
          // rendered shell, so the drag responds from the first pixel
          // instead of swallowing the overshoot (P2).
          expect((await page.goto(settingsUrl.toString()))?.status()).toBe(200);
          await waitForControlUiSettingsTakeover(page);
          const wideInput = page.locator(MESSAGE_WIDTH_INPUT);
          await wideInput.waitFor();
          await wideInput.scrollIntoViewIfNeeded();
          await wideInput.fill("1300px");
          await wideInput.blur();
          await expect.poll(() => readWidthSetting(page), { timeout: 10_000 }).toBe("1300px");
          await page.setViewportSize({ width: 1000, height: 1000 });
          expect((await page.goto(chatUrl.toString()))?.status()).toBe(200);
          await waitForControlUiGatewayReady(page);
          await expect.poll(() => readColumnToken(page), { timeout: 10_000 }).toBe("1300px");
          const shellBox = await page.locator(COMPOSER_SHELL).boundingBox();
          expect(shellBox, "composer shell has a hit box").toBeTruthy();
          const shellWidthPx = Math.round(shellBox!.width);
          // The narrowed pane really does show less than the stored cap.
          expect(shellWidthPx).toBeLessThan(1300);
          await page.locator(COMPOSER_INPUT).hover();
          await dragGrip(page, SIDE_GRIP, 120, 0);
          const narrowedWidth = `${shellWidthPx - 120}px`;
          await expect.poll(() => readWidthSetting(page), { timeout: 10_000 }).toBe(narrowedWidth);
          await expect.poll(() => readColumnToken(page), { timeout: 10_000 }).toBe(narrowedWidth);
          if (captureEnabled) {
            await page.screenshot({ path: path.join(artifactDir, "04-oversized-narrowed.png") });
          }
          await page.setViewportSize({ width: 1440, height: 1000 });

          // Double-click resets to the default and clears the setting, so
          // Settings and the column agree again.
          await page.locator(COMPOSER_INPUT).hover();
          await page.locator(SIDE_GRIP).dblclick();
          await expect.poll(() => readWidthSetting(page), { timeout: 10_000 }).toBeNull();
          const resetToken = await readColumnToken(page);
          expect(resetToken).toBe(defaultWidthToken);
          if (captureEnabled) {
            await page.screenshot({ path: path.join(artifactDir, "05-width-reset.png") });
          }

          // Height: fill past the six-line cap, drag the top grip up, and
          // confirm the editor grows past its CSS cap.
          const editor = page.locator(COMPOSER_TEXTAREA);
          await editor.click();
          await editor.fill(
            Array.from({ length: 14 }, (_, index) => `resize proof line ${index + 1}`).join("\n"),
          );
          const cappedHeight = px(await readEditorMaxHeight(page));
          if (captureEnabled) {
            await page.screenshot({ path: path.join(artifactDir, "05-height-before.png") });
          }
          await dragGrip(page, TOP_GRIP, 0, -150);
          await expect
            .poll(async () => px(await readEditorMaxHeight(page)), { timeout: 10_000 })
            .toBeGreaterThan(cappedHeight + 100);
          const grownHeight = await readEditorMaxHeight(page);
          const storedHeight = await page.evaluate(
            (key) => localStorage.getItem(key),
            COMPOSER_HEIGHT_STORAGE_KEY,
          );
          expect(storedHeight, "height override persists per-device").toBeTruthy();
          if (captureEnabled) {
            await page.screenshot({ path: path.join(artifactDir, "06-height-dragged.png") });
          }

          // Reload restores the persisted height on the fresh textarea.
          await page.reload();
          await waitForControlUiGatewayReady(page);
          await expect.poll(() => readEditorMaxHeight(page), { timeout: 10_000 }).toBe(grownHeight);

          // A viewport-only change must not erase the remembered maximum.
          await page.setViewportSize({ width: 1440, height: 300 });
          await expect.poll(() => readEditorMaxHeight(page)).toBe("240px");
          expect(
            await page.evaluate((key) => localStorage.getItem(key), COMPOSER_HEIGHT_STORAGE_KEY),
          ).toBe(storedHeight);
          await page.setViewportSize({ width: 1440, height: 1000 });
          await expect.poll(() => readEditorMaxHeight(page)).toBe(grownHeight);

          // Double-click returns the editor to its CSS cap.
          await page.locator(TOP_GRIP).dblclick();
          await expect
            .poll(() => readEditorMaxHeight(page), { timeout: 10_000 })
            .toBe(`${cappedHeight}px`);
          expect(
            await page.evaluate((key) => localStorage.getItem(key), COMPOSER_HEIGHT_STORAGE_KEY),
          ).toBeNull();

          // Keyboard users get the same persisted resize and reset operations.
          const top = page.locator(TOP_GRIP);
          const side = page.locator(SIDE_GRIP);
          await top.focus();
          expect(await top.getAttribute("tabindex")).toBe("0");
          await top.press("ArrowUp");
          expect(await readEditorMaxHeight(page)).toBe(`${cappedHeight + 16}px`);
          expect(
            await page.evaluate((key) => localStorage.getItem(key), COMPOSER_HEIGHT_STORAGE_KEY),
          ).toBe(String(cappedHeight + 16));
          expect(await top.getAttribute("aria-valuenow")).toBe(String(cappedHeight + 16));
          await top.press("Home");
          expect(await readEditorMaxHeight(page)).toBe("96px");
          await top.press("End");
          expect(await readEditorMaxHeight(page)).toBe("800px");
          await top.press("Enter");
          expect(await readEditorMaxHeight(page)).toBe(`${cappedHeight}px`);
          expect(
            await page.evaluate((key) => localStorage.getItem(key), COMPOSER_HEIGHT_STORAGE_KEY),
          ).toBeNull();
          const keyboardWidth = Math.round(
            (await page.locator(COMPOSER_SHELL).boundingBox())!.width,
          );
          await side.focus();
          expect(await side.getAttribute("tabindex")).toBe("0");
          await side.press("ArrowLeft");
          await expect.poll(() => readWidthSetting(page)).toBe(`${keyboardWidth + 16}px`);
          await expect
            .poll(() => side.getAttribute("aria-valuenow"))
            .toBe(String(keyboardWidth + 16));
          await side.press("ArrowRight");
          await expect.poll(() => readWidthSetting(page)).toBe(`${keyboardWidth}px`);
          await side.press("Enter");
          await expect.poll(() => readWidthSetting(page)).toBeNull();

          const videoPath = await page.video()?.path();
          await writeFile(
            path.join(artifactDir, "evidence.json"),
            JSON.stringify(
              {
                sessionKey,
                widthSettingAfterDrag: "920px",
                widthTokenAfterReload: "920px",
                widthSettingAfterNoopClick: "720px",
                oversizedStoredWidth: "1300px",
                oversizedShellWidthPx: shellWidthPx,
                widthSettingAfterOversizedNarrow: narrowedWidth,
                widthSettingAfterReset: null,
                widthTokenAfterReset: resetToken,
                editorCappedHeightPx: cappedHeight,
                editorGrownHeight: grownHeight,
                heightStored: storedHeight,
                video: videoPath ? path.basename(videoPath) : null,
              },
              null,
              2,
            ),
          );
        },
      );
    },
    240_000,
  );
});
