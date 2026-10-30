import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { textMessage } from "./chat-flow-fixtures.test-support.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
function createArtifactDir() {
  const root = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
  return root ? createControlUiE2eArtifactDir("chat-flow.clipboard", root) : undefined;
}

type ClipboardFailureProof = {
  asyncAttempts: number;
  legacyAttempts: number;
  value: string;
};
type ClipboardWindow = typeof globalThis & {
  clipboardFailureProof: ClipboardFailureProof;
  resolveClipboardRetry: (failed: boolean, attempt?: number) => void;
};

async function expectClipboard(
  page: Page,
  asyncAttempts: number,
  legacyAttempts: number,
  value: string,
) {
  expect(await readClipboardFailureProof(page)).toEqual({ asyncAttempts, legacyAttempts, value });
}

async function captureFailure(
  page: Page,
  surface: string,
  fullPage = true,
  artifactDir = createArtifactDir(),
) {
  if (artifactDir) {
    await page.screenshot({
      fullPage,
      path: path.join(artifactDir, `clipboard-${surface}-failure.png`),
    });
  }
}

function withClipboardPage(
  options: Parameters<typeof suite.newBrowserContext>[0],
  run: (page: Page) => Promise<void>,
  clock = false,
  fallbackSucceeds = false,
) {
  return suite.withPage(options, async ({ page }) => {
    if (clock) {
      await page.clock.install();
    }
    await installDeniedClipboard(page, fallbackSucceeds);
    await run(page);
  });
}

async function installDeniedClipboard(page: Page, fallbackSucceeds = false): Promise<void> {
  await page.addInitScript((copiedViaFallback) => {
    const proof = { asyncAttempts: 0, legacyAttempts: 0, value: "" };
    Object.defineProperty(globalThis, "clipboardFailureProof", {
      configurable: true,
      value: proof,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          proof.asyncAttempts += 1;
          proof.value = text;
          throw new DOMException("Clipboard access denied", "NotAllowedError");
        },
      },
    });
    document.execCommand = ((command: string) => {
      if (command === "copy") {
        proof.legacyAttempts += 1;
      }
      return copiedViaFallback;
    }) as typeof document.execCommand;
  }, fallbackSucceeds);
}

async function readClipboardFailureProof(page: Page): Promise<ClipboardFailureProof> {
  return page.evaluate(() => (globalThis as ClipboardWindow).clipboardFailureProof);
}

async function deferClipboard(page: Page): Promise<void> {
  await page.evaluate(() => {
    const pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    navigator.clipboard.writeText = (value) => {
      const proof = (globalThis as ClipboardWindow).clipboardFailureProof;
      proof.asyncAttempts += 1;
      proof.value = value;
      return new Promise<void>((resolve, reject) => {
        pending.push({ resolve, reject });
        Object.defineProperty(globalThis, "resolveClipboardRetry", {
          configurable: true,
          value: (failed: boolean, attempt = pending.length - 1) =>
            failed
              ? pending[attempt]!.reject(
                  new DOMException("Clipboard access denied", "NotAllowedError"),
                )
              : pending[attempt]!.resolve(),
        });
      });
    };
  });
}

async function resolveClipboard(page: Page, failed = false, attempt?: number): Promise<void> {
  await page.evaluate(
    ({ rejected, copyAttempt }) =>
      (globalThis as ClipboardWindow).resolveClipboardRetry(rejected, copyAttempt),
    { rejected: failed, copyAttempt: attempt },
  );
}

async function selectBubbleText(bubble: Locator): Promise<void> {
  await bubble.locator(".chat-text").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await bubble.click({ button: "right" });
  // Context-menu dismissal listeners install on the next animation frame.
  await bubble.page().evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }),
  );
}

suite.define(() => {
  it.each(["older first", "newer first"] as const)(
    "keeps the latest keyboard copy focused when writes settle %s",
    async (order) => {
      await withClipboardPage({ locale: "en-US", serviceWorkers: "block" }, async (page) => {
        await installMockGateway(page, {
          historyMessages: [
            textMessage("assistant", "First copy.", { timestamp: 1_000 }),
            textMessage("user", "Next question.", { timestamp: 2_000 }),
            textMessage("assistant", "Second copy.", { timestamp: 3_000 }),
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const copies = ["First copy.", "Second copy."].map((text) =>
          page.locator(".chat-group.assistant").filter({ hasText: text }).locator(".chat-copy-btn"),
        );
        await copies[1]!.waitFor({ state: "attached" });
        await deferClipboard(page);
        for (const copy of copies) {
          await copy.focus();
          await page.keyboard.press("Shift+Tab");
          await page.keyboard.press("Tab");
          expect(
            await copy.evaluate((element) => element.ownerDocument.activeElement === element),
          ).toBe(true);
          await page.keyboard.press("Enter");
          expect(await copy.isDisabled()).toBe(true);
        }
        await expectClipboard(page, 2, 0, "Second copy.");
        const first = order === "older first" ? 0 : 1;
        await resolveClipboard(page, false, first);
        await expect.poll(() => copies[first]!.isDisabled()).toBe(false);
        expect(await copies[1 - first]!.isDisabled()).toBe(true);
        await resolveClipboard(page, false, 1 - first);
        await expect.poll(() => copies[1 - first]!.isDisabled()).toBe(false);
        await expect
          .poll(() =>
            copies[1]!.evaluate((element) => element.ownerDocument.activeElement === element),
          )
          .toBe(true);
      });
    },
  );

  it.each(["modern", "fallback", "failure"] as const)(
    "restores keyboard copy focus after %s settlement without stealing newer focus",
    async (transport) => {
      await withClipboardPage(
        { locale: "en-US", serviceWorkers: "block" },
        async (page) => {
          const text = "Repeat this keyboard copy.";
          const gateway = await installMockGateway(page, {
            historyMessages: [textMessage("assistant", text, { timestamp: 1_000 })],
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          const message = page.locator(".chat-group.assistant").filter({ hasText: text });
          const copy = message.locator(".chat-copy-btn");
          await copy.waitFor({ state: "visible" });
          await deferClipboard(page);
          await copy.focus();
          await page.keyboard.press("Shift+Tab");
          expect(
            await message
              .getByRole("button", { name: "Reply to message" })
              .evaluate((element) => element.ownerDocument.activeElement === element),
          ).toBe(true);
          await page.keyboard.press("Tab");
          expect(
            await copy.evaluate((element) => element.ownerDocument.activeElement === element),
          ).toBe(true);
          await page.keyboard.press("Enter");
          expect(await copy.isDisabled()).toBe(true);
          expect(await copy.getAttribute("aria-busy")).toBe("true");
          await resolveClipboard(page, transport !== "modern");
          await expect
            .poll(() => copy.evaluate((element) => element.ownerDocument.activeElement === element))
            .toBe(true);
          expect(await copy.isDisabled()).toBe(false);
          expect(await copy.getAttribute("aria-busy")).toBeNull();
          expect(await copy.getAttribute("aria-label")).toBe(
            transport === "failure" ? "Copy failed" : "Copied!",
          );
          await expectClipboard(page, 1, transport === "modern" ? 0 : 1, text);
          await page.keyboard.press("Enter");
          expect(await copy.isDisabled()).toBe(true);
          const composer = page.locator(".agent-chat__composer-combobox textarea");
          await composer.focus();
          await resolveClipboard(page, transport !== "modern");
          await expect.poll(() => copy.isDisabled()).toBe(false);
          await expect
            .poll(() =>
              composer.evaluate((element) => element.ownerDocument.activeElement === element),
            )
            .toBe(true);
          await expectClipboard(page, 2, transport === "modern" ? 0 : 2, text);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        },
        false,
        transport === "fallback",
      );
    },
  );

  it.each([
    ...["Escape", "outside click", "replacement", "navigation", "reconnect"].map((dismissal) => ({
      dismissal,
      failed: true,
    })),
    { dismissal: "replacement", failed: false },
  ])(
    "handles pending selection copies after $dismissal (rejected: $failed)",
    async ({ dismissal, failed }) => {
      await withClipboardPage({ locale: "en-US" }, async (page) => {
        const text = "Selected transcript text.";
        const gateway = await installMockGateway(page, {
          historyMessages: [textMessage("assistant", text, { timestamp: 1_000 })],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const bubble = page.locator(".chat-bubble").filter({ hasText: text });
        await bubble.waitFor();
        await deferClipboard(page);
        await selectBubbleText(bubble);
        const menu = page.locator(".chat-reply-context-menu");
        const copy = menu.getByRole("menuitem", { name: "Copy", exact: true });
        await copy.click();
        expect(await copy.isDisabled()).toBe(true);
        if (dismissal === "Escape") {
          await page.keyboard.press("Escape");
        } else if (dismissal === "outside click") {
          await page.locator(".agent-chat__composer-combobox textarea").click();
        } else if (dismissal === "replacement") {
          await selectBubbleText(bubble);
        } else if (dismissal === "navigation") {
          const sidebar = page.locator("openclaw-app-sidebar");
          await sidebar.locator(".sidebar-identity-card").click();
          await sidebar.locator('.sidebar-identity-menu [data-value="command:usage"]').click();
          await expect.poll(() => new URL(page.url()).pathname).toBe("/usage");
        } else {
          const sockets = await gateway.getSocketCount();
          await gateway.closeLatest(1001, "copy lifecycle proof");
          await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(sockets);
          // Reconnection retains this transcript: copy remains owned until dismissal.
          expect(await copy.isDisabled()).toBe(true);
          await page.keyboard.press("Escape");
        }
        if (dismissal !== "replacement") {
          await expect.poll(() => menu.count()).toBe(0);
        }
        if (dismissal === "navigation") {
          await page.goBack();
          await bubble.waitFor();
        }
        if (dismissal !== "replacement") {
          await selectBubbleText(bubble);
        }
        expect(await copy.isDisabled()).toBe(false);
        await resolveClipboard(page, failed);
        await expectClipboard(page, 1, 0, text);
        expect(await copy.count()).toBe(1);
        expect(await copy.isDisabled()).toBe(false);
        expect(await menu.getByRole("menuitem", { name: "Copy failed", exact: true }).count()).toBe(
          0,
        );
        await page.keyboard.press("Escape");
        expect(await menu.count()).toBe(0);
      });
    },
  );

  it.each([
    { action: "copy-path", label: "Copy path", value: "/workspace" },
    { action: "copy-branch", label: "Copy branch name", value: "feature/clipboard" },
  ] as const)(
    "shows a visible error when the workspace header $action clipboard action fails",
    async ({ action, label, value }) => {
      await withClipboardPage(createControlUiE2eContextOptions(), async (page) => {
        const gateway = await installMockGateway(page, {
          workspace: "/default-workspace",
          workspaceGit: true,
          sessions: [{ key: "agent:main:main", kind: "direct", spawnedCwd: "/workspace" }],
          methodResponses: {
            "worktrees.branches": { headBranch: "feature/clipboard" },
          },
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        await page.locator(".chat-pane__workspace-chip").filter({ visible: true }).click();
        await gateway.waitForRequest("worktrees.branches");
        await page
          .locator(".chat-pane__workspace-menu")
          .getByRole("menuitem", { name: label, exact: true })
          .click();

        const alert = page.getByRole("alert").filter({ hasText: "Copy failed" });
        await alert.waitFor({ state: "visible", timeout: 10_000 });
        await expectClipboard(page, 1, 1, value);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);

        await captureFailure(page, action);
      });
    },
  );

  it.each([
    { width: 1280, role: "assistant", index: 0 },
    { width: 1280, role: "assistant", index: 1 },
    { width: 390, role: "assistant", index: 0 },
    { width: 390, role: "assistant", index: 1 },
    { width: 390, role: "user", index: 0 },
    { width: 390, role: "user", index: 1 },
  ] as const)(
    "keeps failed $role copy $index readable and retryable at $width px",
    async ({ width, role, index }) => {
      await withClipboardPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width },
        },
        async (page) => {
          const texts = ["Copy this complete message.", "Keep this other message."] as const;
          await installMockGateway(page, {
            presenceUsers: [
              {
                id: "viewer",
                name: "Viewer",
                identity: { type: "profile", id: "viewer" },
                self: true,
              },
              { id: "peer", name: "Riley", identity: { type: "profile", id: "peer" } },
            ],
            historyMessages: texts.map((text, position) =>
              textMessage(role, text, {
                timestamp: position + 1,
                __openclaw:
                  role === "user"
                    ? {
                        senderId: "peer",
                        senderName: "Riley",
                        senderIdentity: { type: "profile", id: "peer" },
                      }
                    : undefined,
              }),
            ),
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          const message = page.locator(".chat-group").filter({ hasText: texts[0] });
          await expect.poll(() => message.locator(".chat-copy-btn").count()).toBe(2);
          if (role === "user") {
            expect(await message.getAttribute("class")).toContain("chat-group--peer");
          }
          await message.locator(".chat-text").nth(index).click();
          await message.locator(".chat-bubble").nth(index).hover();
          const copy = message.locator(".chat-copy-btn").nth(index);
          await copy.click();
          await page.locator(".agent-chat__composer-combobox textarea").focus();
          await page.mouse.move(0, 0);
          const feedback = message.getByRole("status").filter({ hasText: "Copy failed" });
          await feedback.waitFor({ state: "visible" });
          // Include child controls: their fade can outlive the footer transition.
          await message.evaluate(async (group) => {
            await Promise.all(
              group.getAnimations({ subtree: true }).map((animation) => animation.finished),
            );
          });
          expect(
            await feedback.evaluate((element) =>
              element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
            ),
          ).toBe(true);
          expect(
            await copy.evaluate((element) => {
              const rect = element.getBoundingClientRect();
              return (
                element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
                element.contains(
                  document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
                )
              );
            }),
          ).toBe(true);
          expect(
            await message
              .locator(".chat-copy-btn")
              .nth(1 - index)
              .evaluate((element) =>
                element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
              ),
          ).toBe(false);
          const bounds = await feedback.boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds!.x).toBeGreaterThanOrEqual(0);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
          await expectClipboard(page, 1, 1, texts[index]);
          await deferClipboard(page);
          await copy.click();
          await resolveClipboard(page);
          await expectClipboard(page, 2, 1, texts[index]);
          await page.clock.fastForward(2_000);
          await feedback.waitFor({ state: "hidden" });
          await expect.poll(() => copy.getAttribute("aria-label")).toBe("Copy as markdown");
        },
        true,
      );
    },
  );
});
