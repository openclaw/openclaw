import type { BrowserContextOptions, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { chatMessage, requireRecord, requireString } from "./chat-flow.test-support.ts";
import { polledAttribute } from "./chat-presentation.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI fenced code blocks",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});
const desktop = {
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { height: 900, width: 1440 },
} satisfies BrowserContextOptions;
type Gateway = Awaited<ReturnType<typeof installMockGateway>>;

async function startRun(page: Page, gateway: Gateway, prompt: string) {
  await page.goto(`${suite.server.baseUrl}chat`);
  await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  const request = await gateway.waitForRequest("chat.send");
  return requireString(requireRecord(request.params).idempotencyKey, "chat send idempotency key");
}
function emitDelta(
  gateway: Gateway,
  runId: string,
  text: string,
  deltaText?: string,
  timestamp?: number,
) {
  return gateway.emitGatewayEvent("chat", {
    deltaText,
    runId,
    sessionKey: "main",
    state: "delta",
    message: chatMessage("assistant", text, timestamp === undefined ? {} : { timestamp }),
  });
}

function fencedJson(lineCount: number): string {
  const values = Array.from({ length: lineCount - 2 }, (_, index) => `  ${index},`);
  values[values.length - 1] = values.at(-1)?.slice(0, -1) ?? "";
  return `\`\`\`json\n[\n${values.join("\n")}\n]\n\`\`\``;
}

function fencedProse(language: "text" | "md" | "markdown"): string {
  return `\`\`\`${language}\n${`${language} prose line\n`.repeat(20)}\`\`\``;
}

const shortFence = `\`\`\`json
{
  "status": "${"ready-for-staging-".repeat(4)}",
  "items": [
    "alpha"
  ]
}
\`\`\``;

const wideFence = `\`\`\`bash
openclaw gateway start ${"--flag value ".repeat(40)}
\`\`\``;

async function setThemeMode(page: Page, mode: "dark" | "light"): Promise<void> {
  await page.emulateMedia({ colorScheme: mode });
  await page.evaluate((nextMode) => {
    const root = document.documentElement;
    root.dataset.themeMode = nextMode;
    root.dataset.themeResolved = nextMode;
    root.style.colorScheme = nextMode;
  }, mode);
}

suite.define(() => {
  it("retains code controls when a streaming fence closes", async () => {
    await suite.withPage(desktop, async ({ page }) => {
      const gateway = await installMockGateway(page);
      const runId = await startRun(page, gateway, "Show the deployment checks");
      const initial =
        "```ts\n" +
        Array.from(
          { length: 9 },
          (_, index) => `const check${index} = "${"deployment check ".repeat(8)}";`,
        ).join("\n");
      await emitDelta(gateway, runId, initial, initial);
      const wrapper = page.locator(".chat-bubble.streaming .code-block-wrapper");
      await wrapper.locator(".code-block-expand").click();
      await wrapper.locator(".code-block-wrap").click();
      const retained = await wrapper.elementHandle();
      await polledAttribute(wrapper, "class").toContain("is-expanded");
      await polledAttribute(wrapper, "class").toContain("is-wrapped");
      const suffix = "\n```\n\nAll deployment checks are ready.";
      await emitDelta(gateway, runId, initial + suffix, suffix);
      await expect
        .poll(() => page.locator(".chat-bubble.streaming .chat-text").textContent())
        .toContain("All deployment checks are ready.");
      expect(await retained?.evaluate((element) => element.isConnected)).toBe(true);
      expect(await wrapper.count()).toBe(1);
      expect(await wrapper.getAttribute("class")).toContain("is-wrapped");
      expect(await wrapper.getAttribute("class")).toContain("is-expanded");
    });
  });

  it.each([8, 12])("clips %i block-art lines to seven rendered rows", async (lineCount) => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const art = Array.from({ length: lineCount }, () => "██  ██  ██").join("\n");
      await installMockGateway(page, {
        historyMessages: [{ role: "assistant", content: "```\n" + art + "\n```", timestamp: 1000 }],
      });
      await page.goto(suite.server.baseUrl + "chat");
      const code = page.locator(".code-block-wrapper.is-collapsible code.markdown-block-art");
      await code.waitFor();
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        const geometry = await code.evaluate((element) => ({
          height: element.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
          scrollHeight: element.scrollHeight,
        }));
        // Fractional line boxes are rounded by layout; a whole extra row is not.
        expect(geometry.height).toBeCloseTo(7 * geometry.lineHeight, 0);
        expect(geometry.scrollHeight).toBeGreaterThan(geometry.height);
      }
      const collapsedHeight = await code.evaluate((element) => element.clientHeight);
      await page.locator(".code-block-expand").click();
      expect(await code.evaluate((element) => element.clientHeight)).toBeGreaterThan(
        collapsedHeight,
      );
      expect(await code.textContent()).toBe(art + "\n");
    });
  });

  it("preserves indented code from history through streaming and copying", async () => {
    await suite.withPage(
      { ...desktop, viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          historyMessages: [
            { role: "user", content: "    *user literal*", timestamp: 1000 },
            { role: "assistant", content: "    *assistant literal*", timestamp: 2000 },
          ],
        });
        await page.addInitScript(() => {
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
              writeText: async (text: string) => {
                document.documentElement.dataset.copiedCode = text;
              },
            },
          });
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.locator(".chat-group.assistant .chat-text").waitFor();
        expect(await page.locator(".chat-group.user pre code").textContent()).toBe(
          "*user literal*\n",
        );
        expect(await page.locator(".chat-group.assistant pre code").textContent()).toBe(
          "*assistant literal*\n",
        );
        await page
          .locator(".agent-chat__composer-combobox textarea")
          .fill("Show an indented example");
        await page.getByRole("button", { name: "Send message" }).click();
        const request = await gateway.waitForRequest("chat.send");
        const runId = requireString(requireRecord(request.params).idempotencyKey, "run id");
        const first = "    *first";
        const second = `${first}\n\n    second`;
        for (const text of [first, second]) {
          await emitDelta(gateway, runId, text);
          const code = page.locator(".chat-bubble.streaming pre code");
          await expect
            .poll(() => code.allTextContents())
            .toEqual([text.replace(/^ {4}/gm, "") + "\n"]);
        }
        await page.locator(".chat-bubble.streaming .code-block-copy").click();
        expect(await page.locator("html").getAttribute("data-copied-code")).toBe(
          "*first\n\nsecond",
        );
        await gateway.emitChatFinal({ runId, text: second });
        await expect
          .poll(() => page.locator(".chat-group.assistant pre code").allTextContents())
          .toContain("*first\n\nsecond\n");
      },
    );
  });

  it("highlights a streamed code fence only after its closing marker arrives", async () => {
    await suite.withPage(desktop, async ({ page }) => {
      const gateway = await installMockGateway(page);

      const runId = await startRun(page, gateway, "show TypeScript");
      const openFence = "```ts\nconst value = 1 < 2;";
      await emitDelta(gateway, runId, openFence, openFence, Date.now());
      const streamingCode = page.locator(".chat-bubble.streaming code.language-ts");
      await expect.poll(() => streamingCode.textContent()).toContain("const value = 1 < 2;");
      expect(await streamingCode.locator("span").count()).toBe(0);
      expect(await streamingCode.evaluate((code) => code.classList.contains("hljs"))).toBe(false);
      expect(await page.locator(".chat-bubble.streaming .code-block-copy").count()).toBe(1);

      const completedFence = `${openFence}\n\`\`\``;
      await emitDelta(gateway, runId, completedFence, "\n```", Date.now());
      await polledAttribute(streamingCode, "class").toContain("hljs");
      expect(await streamingCode.locator("span").count()).toBeGreaterThan(0);

      await gateway.emitChatFinal({ runId, text: completedFence });
      await expect.poll(() => page.locator(".chat-thread code.language-ts.hljs").count()).toBe(1);
    });
  });

  it("releases hidden transcript observations and resumes them on the retained code", async () => {
    await suite.withPage(desktop, async ({ page }) => {
      type ObservationWindow = typeof window & {
        codeBlockObservations: () => { observed: number; connected: number; detached: number };
      };
      await page.addInitScript(() => {
        const NativeResizeObserver = window.ResizeObserver;
        const targets = new Map<ResizeObserver, Set<Element>>();
        let observed = 0;
        window.ResizeObserver = class extends NativeResizeObserver {
          override observe(target: Element, options?: ResizeObserverOptions) {
            super.observe(target, options);
            if (target.matches(".code-block-viewport, .code-block-viewport code")) {
              const current = targets.get(this) ?? new Set<Element>();
              current.add(target);
              targets.set(this, current);
              observed += 1;
            }
          }

          override unobserve(target: Element) {
            super.unobserve(target);
            targets.get(this)?.delete(target);
          }

          override disconnect() {
            super.disconnect();
            targets.delete(this);
          }
        };
        (window as ObservationWindow).codeBlockObservations = () => {
          const nodes = [...targets.values()].flatMap((current) => Array.from(current));
          return {
            observed,
            connected: nodes.filter((node) => node.isConnected).length,
            detached: nodes.filter((node) => !node.isConnected).length,
          };
        };
      });
      await installMockGateway(page, {
        historyMessages: [
          { role: "user", content: "Show the launch command.", timestamp: 1_000 },
          { role: "assistant", content: wideFence, timestamp: 2_000 },
        ],
      });
      const observations = () =>
        page.evaluate(() => (window as ObservationWindow).codeBlockObservations());

      await page.goto(`${suite.server.baseUrl}chat`);
      await expect.poll(async () => (await observations()).connected).toBe(2);
      const code = await page.locator(".chat-thread code").elementHandle();
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.locator(".sidebar-identity-card").click();
      await sidebar
        .locator(".sidebar-identity-menu")
        .getByRole("menuitem", { exact: true, name: "Settings" })
        .click();
      await page.locator('.settings-sidebar__item[href="/logs"]').click();
      await page.locator("openclaw-logs-page").waitFor({ state: "visible" });
      await page.locator("openclaw-chat-pane").waitFor({ state: "hidden" });
      expect(await code?.evaluate((element) => element.isConnected)).toBe(true);
      // A page reload would discard the probe too and cannot prove in-app teardown.
      expect((await observations()).observed).toBeGreaterThanOrEqual(2);
      await expect.poll(async () => (await observations()).connected).toBe(0);
      await expect.poll(async () => (await observations()).detached).toBe(0);
      await page.goBack();
      await page.goBack();
      await page.locator(".chat-thread code").waitFor({ state: "visible" });
      expect(
        await page
          .locator(".chat-thread code")
          .evaluate((element, previous) => element === previous, code),
      ).toBe(true);
      await expect.poll(async () => (await observations()).connected).toBe(2);
      expect((await observations()).detached).toBe(0);
    });
  });

  it.each(["dark", "light"] as const)(
    "keeps code controls correct through disclosure, resize, and virtual remount in %s mode",
    async (theme) => {
      await suite.withPage({ ...desktop, colorScheme: theme }, async ({ page }) => {
        await installMockGateway(page, {
          historyMessages: [
            ...Array.from({ length: 40 }, (_, index) => ({
              role: index % 2 === 0 ? "user" : "assistant",
              content: [{ type: "text", text: `Earlier diagnostic turn ${index}` }],
              timestamp: Date.now() - 40 + index,
              __openclaw: { id: `earlier-diagnostic-${index}`, seq: index + 1 },
            })),
            ...(
              [
                ["user", "Show the full diagnostic payload.", "user-fence-long"],
                ["assistant", fencedJson(41), "assistant-fence-long"],
                ["user", "Return the deployment receipt.", "user-fence-short"],
                ["assistant", shortFence, "assistant-fence-short"],
                ["user", "Show the launch command.", "user-fence-wide"],
                ["assistant", wideFence, "assistant-fence-wide"],
              ] as const
            ).map(([role, text, id], index) =>
              chatMessage(role, text, {
                timestamp: Date.now() + index,
                __openclaw: { id, seq: 41 + index },
              }),
            ),
            ...(["text", "md", "markdown"] as const).map((language, index) => ({
              role: "assistant",
              content: [{ type: "text", text: fencedProse(language) }],
              timestamp: Date.now() + 6 + index,
              __openclaw: { id: `assistant-fence-${language}`, seq: 47 + index },
            })),
          ],
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        await setThemeMode(page, theme);
        const shortBubble = page.locator('[data-entry-id="assistant-fence-short"]');
        const longBubble = page.locator('[data-entry-id="assistant-fence-long"]');
        const wideBubble = page.locator('[data-entry-id="assistant-fence-wide"]');
        await wideBubble.waitFor({ state: "visible" });

        // JSON starts in Tree; Raw retains the shared fence preview and wrap contract.
        await shortBubble.getByRole("button", { name: "Raw", exact: true }).click();
        await longBubble.getByRole("button", { name: "Raw", exact: true }).click();

        // A fence at or under the preview budget stays whole and offers no reveal.
        expect(await shortBubble.locator(".code-block-wrapper.is-collapsible").count()).toBe(0);
        expect(await shortBubble.locator(".code-block-expand").count()).toBe(0);
        expect(await shortBubble.locator("pre code").isVisible()).toBe(true);

        for (const language of ["text", "md", "markdown"] as const) {
          const proseBubble = page.locator(`[data-entry-id="assistant-fence-${language}"]`);
          expect(await proseBubble.locator(".code-block-wrapper.is-collapsible").count()).toBe(0);
          expect(await proseBubble.locator(".code-block-expand").count()).toBe(0);
          expect(await proseBubble.locator("pre code").textContent()).toContain(
            `${language} prose line`,
          );
        }

        // The wrap control only appears once a line measurably overflows, and it
        // reverses; the transcript itself must never grow a horizontal scrollbar.
        const wideWrapper = wideBubble.locator(".code-block-wrapper");
        await polledAttribute(wideWrapper, "class").toContain("has-horizontal-overflow");
        const wrapButton = wideWrapper.locator(".code-block-wrap");
        expect(await wrapButton.isVisible()).toBe(true);
        await wrapButton.click();
        await polledAttribute(wideWrapper, "class").toContain("is-wrapped");
        expect(
          await wideWrapper
            .locator(".code-block-viewport")
            .evaluate((viewport) => viewport.scrollWidth - viewport.clientWidth),
        ).toBeLessThanOrEqual(1);
        await wrapButton.click();
        await polledAttribute(wideWrapper, "class").not.toContain("is-wrapped");
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        ).toBe(true);

        // Resize must update existing code controls without another chat message.
        const shortWrapper = shortBubble.locator(".code-block-wrapper");
        const shortWrap = shortWrapper.locator(".code-block-wrap");
        await shortBubble.scrollIntoViewIfNeeded();
        expect(await shortWrap.isVisible()).toBe(false);
        await page.setViewportSize({ width: 560, height: 900 });
        await shortBubble.scrollIntoViewIfNeeded();
        await expect.poll(() => shortWrap.isVisible()).toBe(true);
        await page.setViewportSize({ width: 1440, height: 900 });
        await shortBubble.scrollIntoViewIfNeeded();
        await expect.poll(() => shortWrap.isVisible()).toBe(false);

        // Expand last; the tall row moves the other fences outside the viewport.
        const longWrapper = longBubble.locator(".code-block-wrapper");
        const expand = longWrapper.locator(".code-block-expand");
        expect(await expand.textContent()).toContain("34 hidden lines");
        const clippedHeight = await longWrapper
          .locator(".code-block-viewport")
          .evaluate((viewport) => viewport.clientHeight);
        const visibleCodeHeight = await longWrapper.locator("pre code").evaluate((code) => ({
          height: code.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(getComputedStyle(code).lineHeight),
        }));
        // The hidden-line label counts seven visible lines, not an eighth clipped row.
        expect(visibleCodeHeight.height).toBe(7 * visibleCodeHeight.lineHeight);
        await expand.click();
        await polledAttribute(longWrapper, "class").toContain("is-expanded");
        expect(await expand.isVisible()).toBe(false);
        expect(
          await longWrapper
            .locator(".code-block-viewport")
            .evaluate((viewport) => viewport.clientHeight),
        ).toBeGreaterThan(clippedHeight);

        // Virtualization must initialize replacement DOM in an otherwise quiet transcript.
        const thread = page.locator(".chat-thread");
        // Focused rows stay mounted offscreen; move focus out of the wrap control first.
        await page.locator(".agent-chat__composer-combobox textarea").click();
        await thread.hover();
        await page.mouse.wheel(0, -100_000);
        await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBe(0);
        await expect.poll(() => wideBubble.count()).toBe(0);
        await page.mouse.wheel(0, 100_000);
        await wideBubble.waitFor({ state: "visible" });
        await expect.poll(() => wideWrapper.locator(".code-block-wrap").isVisible()).toBe(true);
        expect(await shortWrapper.locator(".code-block-wrap").isVisible()).toBe(false);
      });
    },
  );
});
