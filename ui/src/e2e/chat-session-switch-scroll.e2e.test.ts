import { webkit, type Browser, type BrowserContext, type Page } from "playwright";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";

let webkitBrowser: Browser;
const suite = createControlUiE2eSuite({
  name: "Chat session switch scroll",
  resources: {
    async run() {
      webkitBrowser = await webkit.launch({ headless: true });
    },
    async close() {
      await webkitBrowser?.close();
    },
  },
});

const prose = [
  "The current implementation reads the saved state, checks the requested operation, and returns the result to the caller.",
  "A restart should preserve the work that has already completed. The next operation can then continue from the recorded position.",
  "The command completed successfully. The remaining question is whether the visible result matches the original request.",
  "The output shows three independent stages: loading the configuration, preparing the workspace, and running the selected action.",
];

/** A long agent session whose settled tool rows and answers render at very different heights. */
function history(label: string, turns: number) {
  const messages: Record<string, unknown>[] = [];
  const add = (role: string, content: unknown[], extra: Record<string, unknown> = {}) =>
    messages.push({ role, content, timestamp: 1794500000000 + messages.length * 1000, ...extra });
  const text = (value: string) => ({ type: "text", text: value });
  for (let turn = 0; turn < turns; turn++) {
    const step = turn + 1;
    const runId = `${label}-run-${step}`;
    add("user", [text(`${label} question ${step}: walk through the change.`)]);
    const calls = turn % 2 ? 0 : turn % 7 === 0 ? 6 : 1;
    for (let call = 0; call < calls; call++) {
      const id = `${label}-call-${step}-${call}`;
      add(
        "assistant",
        [
          text(`I'll inspect file ${call + 1} for step ${step}.`),
          { type: "toolCall", id, name: "read", arguments: { path: `notes/${step}-${call}.md` } },
        ],
        { stopReason: "toolUse", __openclaw: { runId } },
      );
      const lines = Array.from({ length: 6 + ((turn + call) % 15) }, (_, line) => prose[line % 4]);
      add("toolResult", [text(lines.join("\n"))], {
        toolCallId: id,
        toolName: "read",
        isError: false,
        __openclaw: { runId },
      });
    }
    let answer = `${label} answer ${step}: ${prose[turn % 4]}\n\n`;
    if (turn % 5 === 0) {
      answer +=
        "```ts\nconst result = await readSavedState();\nawait continueWork(result);\n```\n\n";
    }
    answer += Array.from({ length: 1 + (turn % 5) }, (_, part) =>
      prose[(turn + part) % 4]!.repeat(1 + ((turn + part) % 3)),
    ).join("\n\n");
    add("assistant", [text(answer)], { stopReason: "stop", __openclaw: { runId } });
  }
  return messages;
}

const sessions = ["Alpha", "Bravo", "Charlie", "Delta"].map((label, index) => ({
  label,
  key: `agent:main:dashboard:00000000-0000-4000-8000-00000000000${index + 1}`,
  turns: 90 + index * 15,
}));

type Viewport = { gap: number; top: number; lastVisible: boolean };

function readViewport(page: Page, index: number): Promise<Viewport> {
  const { label, turns } = sessions[index]!;
  return page.evaluate(
    ({ marker }) => {
      const thread = document.querySelector<HTMLElement>(
        ".chat-pane-cache__pane--active .chat-thread",
      );
      if (!thread) {
        return { gap: -1, top: -1, lastVisible: false };
      }
      const view = thread.getBoundingClientRect();
      const lastVisible = [...thread.querySelectorAll<HTMLElement>("p")].some((node) => {
        const rect = node.getBoundingClientRect();
        return (
          node.textContent.startsWith(marker) && rect.bottom > view.top && rect.top < view.bottom
        );
      });
      return {
        gap: Math.round(thread.scrollHeight - thread.clientHeight - thread.scrollTop),
        top: Math.round(thread.scrollTop),
        lastVisible,
      };
    },
    { marker: `${label} answer ${turns}:` },
  );
}

function isInView(page: Page, text: string): Promise<boolean> {
  return page.evaluate((needle) => {
    const thread = document.querySelector<HTMLElement>(
      ".chat-pane-cache__pane--active .chat-thread",
    );
    const view = thread?.getBoundingClientRect();
    return [...(thread?.querySelectorAll<HTMLElement>("p") ?? [])].some((node) => {
      const rect = node.getBoundingClientRect();
      return (
        node.textContent.includes(needle) &&
        view !== undefined &&
        rect.height > 0 &&
        rect.bottom > view.top &&
        rect.top < view.bottom
      );
    });
  }, text);
}

async function open(page: Page, index: number, latest = true): Promise<void> {
  await page
    .locator(
      `.sidebar-sessions [data-session-key="${sessions[index]!.key}"] .sidebar-recent-session__link`,
    )
    .first()
    .click();
  if (!latest) {
    return;
  }
  await page
    .locator(".chat-pane-cache__pane--active")
    .getByText(`${sessions[index]!.label} answer ${sessions[index]!.turns}:`, { exact: false })
    .waitFor();
}

/** The reader stays at the latest message once rows finish measuring, not just briefly. */
async function expectAtLatest(page: Page, index: number, step: string): Promise<void> {
  await expect
    .poll(() => readViewport(page, index), { message: step, timeout: 4000 })
    .toMatchObject({ lastVisible: true });
  await expect
    .poll(async () => (await readViewport(page, index)).gap, { message: step, timeout: 4000 })
    .toBeLessThanOrEqual(8);
  await page.waitForTimeout(700);
  expect((await readViewport(page, index)).gap, `${step} after settling`).toBeLessThanOrEqual(8);
}

suite.define(() => {
  it.each(["chromium", "webkit"] as const)(
    "returns each chat to its reader position after switching (%s)",
    async (engine) => {
      // The macOS app hosts this page in WebKit, at its default full-window size.
      const options = {
        viewport: { width: 1512, height: 921 },
        locale: "en-US",
        serviceWorkers: "block" as const,
      };
      const context: BrowserContext =
        engine === "chromium"
          ? await suite.newBrowserContext(options)
          : await webkitBrowser.newContext(options);
      try {
        const page = await context.newPage();
        await installNativeWebChrome(page);
        const gateway = await installMockGateway(page, {
          sessionKey: sessions[0]!.key,
          sessions: sessions.map(({ key, label }, index) => ({
            key,
            label,
            displayName: label,
            kind: "direct",
            updatedAt: 1794600000000 - index * 1000,
          })),
          sessionTranscripts: Object.fromEntries(
            sessions.map(({ key, label, turns }) => [key, { messages: history(label, turns) }]),
          ),
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessions[0]!.key));
        await expectAtLatest(page, 0, "open Alpha");

        // Revisits cover retained panes and, after three other chats, a rebuilt one.
        for (const [step, index] of [
          ["Alpha -> Bravo", 1],
          ["Bravo -> Alpha", 0],
          ["Alpha -> Charlie", 2],
          ["Charlie -> Delta", 3],
          ["Delta -> Bravo", 1],
          ["Bravo -> Alpha after three others", 0],
        ] as const) {
          await open(page, index);
          await expectAtLatest(page, index, step);
        }

        // A reply that lands while the chat is in the background is in view on return.
        await open(page, 3);
        await expectAtLatest(page, 3, "Alpha -> Delta");
        const late = "Bravo late reply: the background run finished while you were away.";
        await gateway.emitChatFinal({
          sessionKey: sessions[1]!.key,
          runId: "bravo-late",
          text: late,
        });
        await page.waitForTimeout(500);
        await open(page, 1, false);
        await expect
          .poll(() => isInView(page, late), { message: "Delta -> Bravo (late reply)" })
          .toBe(true);
        await expect
          .poll(async () => (await readViewport(page, 1)).gap, {
            message: "Delta -> Bravo (late reply)",
          })
          .toBeLessThanOrEqual(8);
        await open(page, 0);
        await expectAtLatest(page, 0, "Bravo -> Alpha");

        // A reader who scrolled up returns to the same place.
        const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
        await thread.hover({ position: { x: 600, y: 300 } });
        for (let step = 0; step < 8; step++) {
          await page.mouse.wheel(0, -400);
          await page.waitForTimeout(60);
        }
        await page.waitForTimeout(700);
        const reading = await readViewport(page, 0);
        expect(reading.gap).toBeGreaterThan(1000);
        await open(page, 3);
        await expectAtLatest(page, 3, "Alpha (scrolled up) -> Delta");
        await open(page, 0, false);
        await page.waitForTimeout(1500);
        const returned = await readViewport(page, 0);
        expect(Math.abs(returned.top - reading.top), "Delta -> Alpha (scrolled up)").toBeLessThan(
          4,
        );
      } finally {
        await (engine === "chromium" ? suite.closeBrowserContext(context) : context.close());
      }
    },
  );
});
