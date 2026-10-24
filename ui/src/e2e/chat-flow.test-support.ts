import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import { createRequireRecord } from "../../../test/helpers/record.js";
import { installMockGateway, type MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

export { expectDefined, installMockGateway };
export { SESSION_DRAG_MIME } from "../lib/sessions/drag.ts";
export {
  controlUiSessionPath,
  controlUiSessionUrl,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";

export const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

// These suites track contexts and close them in their existing afterEach hook.
export async function newChatPage(
  suite: ReturnType<typeof createControlUiE2eSuite>,
  options = createControlUiE2eContextOptions(),
): Promise<Page> {
  return (await suite.newBrowserContext(options)).newPage();
}

export function textContent(text: string) {
  return [{ type: "text", text }];
}

export function exactButton(root: Page | Locator, name: string) {
  return root.getByRole("button", { name, exact: true });
}

export function chatMessage(role: string, text: string, extra?: Record<string, unknown>) {
  return { role, content: textContent(text), ...extra };
}

export function thinkingLevels(...ids: string[]) {
  return ids.map((id) => ({ id, label: id }));
}

export const QUEUED = [
  "review the migration",
  "then update the docs",
  "finally run the smoke",
] as const;

export async function queueMessages(page: Page, messages: readonly string[] = QUEUED) {
  const composer = page.locator(".agent-chat__composer-combobox textarea");
  for (const message of messages) {
    await composer.fill(message);
    await composer.press("Enter");
    await page.locator(".chat-queue__item", { hasText: message }).waitFor({ timeout: 10_000 });
  }
}

export async function confirmIme(locator: Locator, text: string) {
  return locator.evaluate((textarea, data) => {
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const end = new CompositionEvent("compositionend", { bubbles: true, data });
    textarea.dispatchEvent(end);
    const confirm = new KeyboardEvent("keydown", {
      key: "Enter",
      keyCode: 13,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(confirm, "timeStamp", { value: end.timeStamp - 1 });
    textarea.dispatchEvent(confirm);
    return confirm.defaultPrevented;
  }, text);
}

export async function captureUiProof(
  owner: { readonly artifactDir: string },
  page: Page,
  directory: string,
  fileName: string,
): Promise<void> {
  if (!captureUiProofEnabled) {
    return;
  }
  const artifactDir = path.join(owner.artifactDir, directory);
  await mkdir(artifactDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(artifactDir, fileName),
  });
}

export function createChatFlowE2eSuite(
  browserLaunchOptions?: Parameters<typeof createControlUiE2eSuite>[0]["browserLaunchOptions"],
) {
  return createControlUiE2eSuite({
    browserLaunchOptions,
    name: "Control UI mocked Gateway E2E",
    trackBrowserContexts: true,
    unavailableMessage: (executablePath) =>
      `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a compatible browser, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
  });
}

export async function buildLocalWebchatAudioMessage(source: string) {
  const { buildWebchatAssistantMessageFromReplyPayloads } =
    await import("../../../src/gateway/server-methods/chat-webchat-media.ts");
  const audioPath = new URL(source).pathname;
  const localRoot = path.dirname(audioPath);
  await mkdir(localRoot, { recursive: true });
  await writeFile(audioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
  return expectDefined(
    await buildWebchatAssistantMessageFromReplyPayloads(
      [{ mediaUrl: source, trustedLocalMedia: true }],
      { localRoots: [localRoot] },
    ),
    "Gateway-produced WebChat audio message",
  );
}

export const requireRecord = createRequireRecord("record", "expected-object-value");

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
  match?: Record<string, unknown>,
): Promise<MockGatewayRequest[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const requests = await gateway.getRequests(method, match);
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
  match?: Record<string, unknown>,
): Promise<void> {
  const deadline = Date.now() + durationMs;
  do {
    expect(await gateway.getRequests(method, match)).toHaveLength(count);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  } while (Date.now() < deadline);
}

export async function installPlainHttpClipboardCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const capture = globalThis as unknown as { copiedViaExec: string[] };
    capture.copiedViaExec = [];
    document.execCommand = ((command: string) => {
      if (command !== "copy") {
        return false;
      }
      const active = document.activeElement as HTMLTextAreaElement | null;
      capture.copiedViaExec.push(active?.value ?? "");
      return true;
    }) as typeof document.execCommand;
  });
}

export async function copiedViaExec(page: Page): Promise<string[]> {
  return page.evaluate(() => (globalThis as unknown as { copiedViaExec: string[] }).copiedViaExec);
}

export async function chatThreadDistanceFromBottom(page: Page): Promise<number> {
  return page.locator(".chat-pane-cache__pane--active .chat-thread").evaluate((element) => {
    const thread = element as HTMLElement;
    return Math.round(thread.scrollHeight - thread.scrollTop - thread.clientHeight);
  });
}

export async function waitForChatScrollIdle(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.locator(".chat-pane-cache__pane--active .chat-thread").evaluate(async (element) => {
          const thread = element as HTMLElement;
          const readGeometry = () => [
            thread.clientHeight,
            thread.scrollHeight,
            Math.round(thread.scrollTop),
          ];
          // Returning to the same offset can still leave a virtualizer idle callback pending.
          let scrolled = false;
          const onScroll = () => {
            scrolled = true;
          };
          thread.addEventListener("scroll", onScroll, { passive: true });
          try {
            const before = readGeometry();
            await new Promise<void>((resolve) => {
              globalThis.setTimeout(resolve, 180);
            });
            await new Promise(requestAnimationFrame);
            await new Promise(requestAnimationFrame);
            const after = readGeometry();
            return !scrolled && before.every((value, index) => value === after[index]);
          } finally {
            thread.removeEventListener("scroll", onScroll);
          }
        }),
      { timeout: 10_000 },
    )
    .toBe(true);
}

export async function scrollChatThreadToTop(page: Page): Promise<void> {
  const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
  // Reader input retires pending end-follow; a raw offset write can be maintenance.
  await thread.hover();
  await page.mouse.wheel(0, -(await thread.evaluate((element) => element.scrollHeight)));
  await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBe(0);
}

export async function captureSessionAccessibilityProof(
  owner: { readonly artifactDir: string },
  page: Page,
  name: string,
): Promise<void> {
  if (!captureUiProofEnabled) {
    return;
  }
  const proofPath = path.join(owner.artifactDir, "session-accessibility", name);
  const sidebar = page.locator("openclaw-app-sidebar");
  await page.screenshot({
    fullPage: true,
    path: `${proofPath}.png`,
  });
  await writeFile(`${proofPath}.yml`, await sidebar.ariaSnapshot(), "utf8");
}

export async function visibleChatBubbleTexts(page: Page): Promise<string[]> {
  return page.locator(".chat-pane-cache__pane--active .chat-thread").evaluate((element) => {
    const thread = element as HTMLElement;
    const viewport = thread.getBoundingClientRect();
    return Array.from(thread.querySelectorAll(".chat-bubble"))
      .filter((candidate) => {
        const { height, width, bottom, top } = candidate.getBoundingClientRect();
        return height > 0 && width > 0 && bottom > viewport.top && top < viewport.bottom;
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

/** Read native queued Blobs without going through a credential-filtered UI projection. */
export async function readOutboxPayloadAttachments(page: Page, key: string) {
  return page.evaluate(async (payloadKey) => {
    type StoredPayload = {
      attachments: Array<{ blob: Blob; fileName?: string; mimeType: string }>;
    };
    const result = <T>(request: IDBRequest<T>, message: string) =>
      new Promise<T>((resolve, reject) => {
        request.addEventListener("success", () => resolve(request.result), { once: true });
        request.addEventListener("error", () => reject(request.error ?? new Error(message)), {
          once: true,
        });
      });
    const database = await result(indexedDB.open("openclaw-control-ui"), "IDB open failed");
    try {
      const payload = await result<StoredPayload | undefined>(
        database.transaction("outboxPayloads").objectStore("outboxPayloads").get(payloadKey),
        "IDB read failed",
      );
      return payload
        ? Promise.all(
            payload.attachments.map(async ({ blob, fileName, mimeType }) => {
              let binary = "";
              for (const byte of new Uint8Array(await blob.arrayBuffer())) {
                binary += String.fromCharCode(byte);
              }
              return { fileName, mimeType, base64: btoa(binary) };
            }),
          )
        : null;
    } finally {
      database.close();
    }
  }, key);
}
