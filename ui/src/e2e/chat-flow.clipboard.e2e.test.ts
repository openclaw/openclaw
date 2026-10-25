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
  resolveClipboardRetry: (failed: boolean) => void;
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
) {
  return suite.withPage(options, async ({ page }) => {
    if (clock) {
      await page.clock.install();
    }
    await installDeniedClipboard(page);
    await run(page);
  });
}

async function installDeniedClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
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
      return false;
    }) as typeof document.execCommand;
  });
}

async function readClipboardFailureProof(page: Page): Promise<ClipboardFailureProof> {
  return page.evaluate(() => (globalThis as ClipboardWindow).clipboardFailureProof);
}

async function deferClipboard(page: Page): Promise<void> {
  await page.evaluate(() => {
    navigator.clipboard.writeText = (value) => {
      const proof = (globalThis as ClipboardWindow).clipboardFailureProof;
      proof.asyncAttempts += 1;
      proof.value = value;
      return new Promise<void>((resolve, reject) => {
        Object.defineProperty(globalThis, "resolveClipboardRetry", {
          configurable: true,
          value: (failed: boolean) =>
            failed
              ? reject(new DOMException("Clipboard access denied", "NotAllowedError"))
              : resolve(),
        });
      });
    };
  });
}

async function resolveClipboard(page: Page, failed = false): Promise<void> {
  await page.evaluate(
    (rejected) => (globalThis as ClipboardWindow).resolveClipboardRetry(rejected),
    failed,
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

  it.each([1280, 390])(
    "keeps message-copy failure readable after leaving the control at %dpx",
    async (width) => {
      await withClipboardPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width },
        },
        async (page) => {
          await installMockGateway(page, {
            historyMessages: [textMessage("assistant", "Copy this complete message.")],
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          const message = page.locator(".chat-group.assistant").filter({
            hasText: "Copy this complete message.",
          });
          await message.locator(".chat-text").click();
          await message.hover();
          const copy = message.getByRole("button", { name: "Copy as markdown", exact: true });
          await copy.click();
          await page.locator(".agent-chat__composer-combobox textarea").focus();
          await page.mouse.move(0, 0);
          const feedback = message.getByRole("status").filter({ hasText: "Copy failed" });
          await feedback.waitFor({ state: "visible" });
          expect(
            await feedback.evaluate((element) =>
              element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
            ),
          ).toBe(true);
          const bounds = await feedback.boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds!.x).toBeGreaterThanOrEqual(0);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
          await expectClipboard(page, 1, 1, "Copy this complete message.");
          await page.clock.fastForward(2_000);
          await feedback.waitFor({ state: "hidden" });
          await expect.poll(() => copy.getAttribute("aria-label")).toBe("Copy as markdown");
        },
        true,
      );
    },
  );
});
