import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { Page } from "playwright";
import { expect } from "vitest";
import { SESSION_DRAG_MIME } from "../lib/sessions/drag.ts";
import {
  controlUiSessionPath,
  controlUiSessionUrl,
  installMockGateway,
  pauseVirtualClock,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

export {
  expectDefined,
  SESSION_DRAG_MIME,
  controlUiSessionPath,
  controlUiSessionUrl,
  installMockGateway,
  pauseVirtualClock,
};

export const managedImageCacheProofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "managed-image-cache",
);
export const channelStopProofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "channel-stop",
);
export const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const sessionAccessibilityProofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "session-accessibility",
);

export function createChatFlowE2eSuite() {
  return createControlUiE2eSuite({
    name: "Control UI mocked Gateway E2E",
    trackBrowserContexts: true,
    unavailableMessage: (executablePath) =>
      `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a compatible browser, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
  });
}

export function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object value");
  }
  return value as Record<string, unknown>;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Expected non-empty ${label}`);
  }
  return value;
}

export async function waitForRequests(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  method: string,
  count: number,
): Promise<MockGatewayRequest[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const requests = await gateway.getRequests(method);
    if (requests.length >= count) {
      return requests;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`Timed out waiting for ${count} ${method} requests`);
}

export async function expectRequestCountStable(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  method: string,
  count: number,
  durationMs = 500,
): Promise<void> {
  const deadline = Date.now() + durationMs;
  do {
    expect(await gateway.getRequests(method)).toHaveLength(count);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  } while (Date.now() < deadline);
}

export async function installPlainHttpClipboardCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    (globalThis as unknown as { copiedViaExec: string[] }).copiedViaExec = [];
    document.execCommand = ((command: string) => {
      if (command !== "copy") {
        return false;
      }
      const active = document.activeElement as HTMLTextAreaElement | null;
      (globalThis as unknown as { copiedViaExec: string[] }).copiedViaExec.push(
        active?.value ?? "",
      );
      return true;
    }) as typeof document.execCommand;
  });
}

export async function copiedViaExec(page: Page): Promise<string[]> {
  return page.evaluate(() => (globalThis as unknown as { copiedViaExec: string[] }).copiedViaExec);
}

export async function chatThreadDistanceFromBottom(page: Page): Promise<number> {
  return page.locator(".chat-thread").evaluate((element) => {
    const thread = element as HTMLElement;
    return Math.round(thread.scrollHeight - thread.scrollTop - thread.clientHeight);
  });
}

export async function waitForChatScrollIdle(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.locator(".chat-thread").evaluate(async (element) => {
          const thread = element as HTMLElement;
          const readGeometry = () => ({
            clientHeight: thread.clientHeight,
            scrollHeight: thread.scrollHeight,
            scrollTop: Math.round(thread.scrollTop),
          });
          const before = readGeometry();
          await new Promise<void>((resolve) => {
            globalThis.setTimeout(resolve, 180);
          });
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => resolve());
            });
          });
          const after = readGeometry();
          return (
            before.clientHeight === after.clientHeight &&
            before.scrollHeight === after.scrollHeight &&
            before.scrollTop === after.scrollTop
          );
        }),
      { timeout: 10_000 },
    )
    .toBe(true);
}

export async function scrollChatThreadToTop(page: Page): Promise<void> {
  await page.locator(".chat-thread").evaluate((element) => {
    const thread = element as HTMLElement;
    thread.scrollTop = 0;
    thread.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

export async function captureSessionAccessibilityProof(page: Page, name: string): Promise<void> {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(sessionAccessibilityProofDir, { recursive: true });
  const sidebar = page.locator("openclaw-app-sidebar");
  await page.screenshot({
    fullPage: true,
    path: path.join(sessionAccessibilityProofDir, `${name}.png`),
  });
  await writeFile(
    path.join(sessionAccessibilityProofDir, `${name}.yml`),
    await sidebar.ariaSnapshot(),
    "utf8",
  );
}

export async function visibleChatBubbleTexts(page: Page): Promise<string[]> {
  return page.locator(".chat-thread").evaluate((element) => {
    const thread = element as HTMLElement;
    const viewport = thread.getBoundingClientRect();
    return Array.from(thread.querySelectorAll(".chat-bubble"))
      .filter((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return (
          rect.height > 0 &&
          rect.width > 0 &&
          rect.bottom > viewport.top &&
          rect.top < viewport.bottom
        );
      })
      .map((candidate) => candidate.textContent?.trim() ?? "")
      .filter(Boolean);
  });
}

export function chatSessionListResponse(
  sessions: Array<
    Record<string, unknown> & {
      key: string;
      kind: string;
      label: string;
      updatedAt: number;
    }
  > = [
    { key: "agent:main:session-a", kind: "direct", label: "Session A", updatedAt: 2 },
    { key: "agent:main:session-b", kind: "direct", label: "Session B", updatedAt: 1 },
  ],
) {
  return {
    count: sessions.length,
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions,
    ts: Date.now(),
  };
}

export async function sidebarSessionOrder(page: Page): Promise<string[]> {
  return page
    .locator(".sidebar-recent-session")
    .evaluateAll((rows) =>
      rows
        .map((row) => row.getAttribute("data-session-key") ?? "")
        .filter((key) => key.startsWith("agent:main:session-")),
    );
}

type ManagedImageClipboardProof = { size: number; type: string };

async function installManagedImageClipboardCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "write", {
      configurable: true,
      value: async (items: ClipboardItem[]) => {
        const png = await items[0]?.getType("image/png");
        if (png) {
          (
            globalThis as typeof globalThis & {
              managedImageClipboardProof?: ManagedImageClipboardProof;
            }
          ).managedImageClipboardProof = { size: png.size, type: png.type };
        }
      },
    });
  });
}

async function readManagedImageClipboardCapture(
  page: Page,
): Promise<ManagedImageClipboardProof | null> {
  return await page.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          managedImageClipboardProof?: ManagedImageClipboardProof;
        }
      ).managedImageClipboardProof ?? null,
  );
}

export async function addManagedImageActionProof(
  page: Page,
  proof: {
    clipboardBytes: number;
    clipboardType: string;
    downloadedFileName: string;
  },
): Promise<void> {
  await page.evaluate((value) => {
    const panel = document.createElement("pre");
    panel.dataset.managedImageActionProof = "true";
    panel.style.cssText = [
      "position:fixed",
      "right:24px",
      "bottom:24px",
      "z-index:2147483647",
      "margin:0",
      "padding:14px 16px",
      "border:1px solid rgba(255,255,255,.2)",
      "border-radius:10px",
      "background:#111827",
      "box-shadow:0 12px 40px rgba(0,0,0,.45)",
      "color:#e5e7eb",
      "font:12px/1.45 ui-monospace,monospace",
      "white-space:pre-wrap",
    ].join(";");
    panel.textContent = [
      "Exact-head browser proof",
      "✓ Open: full image displayed",
      `✓ Download: ${value.downloadedFileName}`,
      `✓ Copy: ${value.clipboardType} (${value.clipboardBytes} bytes)`,
    ].join("\n");
    document.body.appendChild(panel);
  }, proof);
}

export async function exerciseManagedImageActions(
  page: Page,
  requestedVariants: string[],
): Promise<{
  clipboardBytes: number;
  clipboardType: string;
  downloadedFileName: string;
}> {
  const imageFrame = page.locator(".chat-image-frame");
  await imageFrame.hover();
  const actions = page.locator(".chat-image-action");
  await actions.first().waitFor({ state: "visible", timeout: 10_000 });
  expect(await actions.count()).toBe(3);

  const [download] = await Promise.all([page.waitForEvent("download"), actions.nth(1).click()]);
  expect(download.suggestedFilename()).toBe("Ticketed generated image.png");
  await expect.poll(() => requestedVariants).toEqual(["thumbnail", "full"]);

  await installManagedImageClipboardCapture(page);
  await actions.nth(2).click();
  const readClipboardProof = () => readManagedImageClipboardCapture(page);
  await expect.poll(readClipboardProof).toMatchObject({ type: "image/png" });
  const clipboardProof = await readClipboardProof();
  expect(clipboardProof?.size).toBeGreaterThan(0);
  await expect.poll(() => requestedVariants).toEqual(["thumbnail", "full", "full"]);

  await actions.first().click();
  await page
    .locator("openclaw-image-lightbox .lightbox")
    .waitFor({ state: "visible", timeout: 10_000 });
  await expect.poll(() => requestedVariants).toEqual(["thumbnail", "full", "full", "full"]);
  await page.locator("openclaw-image-lightbox .close").click();
  await imageFrame.hover();

  return {
    clipboardBytes: clipboardProof?.size ?? 0,
    clipboardType: clipboardProof?.type ?? "",
    downloadedFileName: download.suggestedFilename(),
  };
}
