import type { Locator, Page } from "playwright";
import { expect as browserExpect } from "playwright/test";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
  createControlUiMockSameOriginGatewayScript,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const checkpoint = (index: number) =>
  `Conversation checkpoint ${index + 1}: review the notes and confirm the next step.`;
const railPage = (
  run: (page: Page) => Promise<void>,
  options: Parameters<typeof suite.withPage>[0] = {
    colorScheme: "dark",
    viewport: { width: 1440, height: 900 },
  },
) => suite.withPage(options, ({ page }) => run(page));

function railMessages(count: number, prefix: string, text: (index: number) => string) {
  return Array.from({ length: count }, (_, index) => ({
    __openclaw: { id: `${prefix}-${index}`, seq: index + 1 },
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: text(index) }],
  }));
}
const scrollTop = (locator: Locator) => locator.evaluate((element) => element.scrollTop);
const boxHeight = async (locator: Locator) => (await locator.boundingBox())!.height;
const chat = (page: Page) => ({
  transcript: page.locator(".chat-thread"),
  track: page.locator(".chat-position-rail__track"),
  marks: page.locator(".chat-position-rail__marks"),
  composer: page.locator(".agent-chat__composer-shell"),
});
async function keepRailAnchored(page: Page, count: number, direction: string) {
  const sessionKey = "agent:main:main";
  const runId = "stable-rail-run";
  const sessionInfo = { key: sessionKey, hasActiveRun: true, activeRunIds: [runId] };
  await installMockGateway(page, {
    sessionKey,
    sessionInfo,
    sessions: [sessionInfo],
    inFlightRun: { runId, startedAt: Date.now() },
    historyMessages: railMessages(
      count,
      "stable-rail",
      (index) =>
        `${direction === "rtl" ? "راجع الملاحظات. " : ""}${checkpoint(index)}${count <= 8 && index === count - 1 ? "\n\nSupporting context keeps this small set of turns scrollable while testing the rail anchor.".repeat(16) : ""}`,
    ),
    featureMethods: [...defaultControlUiFeatureMethods, "progressCard.get"],
    methodResponses: {
      "progressCard.get": {
        card: {
          sessionKey,
          runId,
          revision: 1,
          updatedAt: Date.now(),
          markdown: "Review the conversation and verify navigation.",
          steps: [
            { step: "Read the conversation", status: "completed" },
            { step: "Verify navigation controls", status: "in_progress" },
            { step: "Check the final evidence", status: "pending" },
          ],
        },
      },
    },
  });
  await page.addInitScript(createControlUiMockSameOriginGatewayScript());
  if (direction === "rtl") {
    await page.addInitScript(() => localStorage.setItem("openclaw.i18n.locale", "ar"));
  }
  await page.goto(`${suite.server.baseUrl}chat`);
  await page.locator(`.chat-text[dir="${direction}"]`).first().waitFor();
  if (count === 1 || count === 5) {
    // These fixtures end with a clamped user message; expose its scrollable content.
    await page.getByRole("button", { name: "Show more", exact: true }).click();
    await waitForChatScrollIdle(page);
    // Expanding a message preserves the reader position, so establish the baseline explicitly.
    await page.locator(".chat-thread").focus();
    await page.keyboard.press("End");
    await waitForChatScrollIdle(page);
  }
  const card = page.locator('[data-progress-card-placement="details"]');
  expect(await card.isVisible()).toBe(false);
  const detailsToggle = page.locator(".chat-details-toggle");
  await detailsToggle.click();
  const details = page.locator('.chat-details[role="dialog"]');
  await details.waitFor();
  await card.waitFor();
  await waitForChatScrollIdle(page);
  const summary = card.locator("summary");
  if ((await card.getAttribute("open")) !== null) {
    await summary.click();
  }
  await expect
    .poll(() =>
      card.evaluate((element) => getComputedStyle(element, "::details-content").blockSize),
    )
    .toBe("0px");
  const { transcript, track, marks, composer } = chat(page);
  await track.waitFor();
  const markers = marks.locator(".chat-position-rail__marker");
  const bounds = () => track.evaluate((element) => element.getBoundingClientRect().toJSON());
  const collapsed = await bounds();
  const transcriptBounds = (await transcript.boundingBox())!;
  expect(collapsed.left).toBeGreaterThanOrEqual(transcriptBounds.x);
  expect(collapsed.right).toBeLessThanOrEqual(transcriptBounds.x + transcriptBounds.width);
  const collapsedComposer = (await composer.boundingBox())!;
  if (count === 80 && direction === "ltr") {
    await transcript.hover();
    await page.mouse.wheel(0, -4);
    await expect
      .poll(() =>
        transcript.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBe(4);
  }
  const anchorIndex = await markers.evaluateAll((elements) => {
    const viewport = elements[0]!.closest(".chat-position-rail__marks")!.getBoundingClientRect();
    return Math.max(
      0,
      elements.findIndex((element) => {
        const marker = element.getBoundingClientRect();
        return marker.top >= viewport.top + 60 && marker.bottom <= viewport.bottom - 60;
      }),
    );
  });
  const anchorTick = markers.nth(anchorIndex).locator(".chat-position-rail__tick");
  const tickTop = (await anchorTick.boundingBox())!.y;
  const probe = await track.evaluateHandle((element, index) => {
    const tick = element.querySelectorAll(".chat-position-rail__tick")[index]!;
    const frame = () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    const anchor = () => ({
      track: element.getBoundingClientRect().top,
      tick: tick.getBoundingClientRect().top,
    });
    return {
      async sample() {
        const positions = [];
        for (let frameIndex = 0; frameIndex < 30; frameIndex++) {
          positions.push({
            ...anchor(),
            connected: element.isConnected,
            display: getComputedStyle(element.closest(".chat-position-rail")!).display,
          });
          await frame();
        }
        return positions;
      },
    };
  }, anchorIndex);
  const sampleAnchor = () => probe.evaluate((state) => state.sample());
  const assertAnchor = async (
    samples: ReturnType<typeof sampleAnchor>,
    anchor = { track: collapsed.top, tick: tickTop },
  ) => {
    for (const position of await samples) {
      expect(position).toMatchObject({ connected: true, display: "block", ...anchor });
    }
  };
  for (const open of [true, false, true, false, true]) {
    const samples = sampleAnchor();
    await summary.click();
    await expect
      .poll(() => card.evaluate((element) => (element as HTMLDetailsElement).open))
      .toBe(open);
    await expect.poll(() => boxHeight(composer)).toBe(collapsedComposer.height);
    await assertAnchor(samples);
    expect((await bounds()).top).toBe(collapsed.top);
    expect((await anchorTick.boundingBox())!.y).toBe(tickTop);
  }
  await detailsToggle.click();
  await details.waitFor({ state: "hidden" });
  const expandedHeight = await boxHeight(marks);
  const textarea = page.locator(".agent-chat__composer-combobox textarea");
  const beforeDraft = await textarea.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
  }));
  const beforeDraftComposer = await boxHeight(composer);
  const expandedDraft = "Review note: keep navigation visible.\n".repeat(5) + "Review note.";
  const textareaSamples = sampleAnchor();
  await textarea.fill(expandedDraft);
  await expect
    .poll(() => boxHeight(textarea))
    .toBeGreaterThanOrEqual(beforeDraft.height + beforeDraft.lineHeight * 4);
  await expect.poll(() => boxHeight(composer)).toBeGreaterThan(beforeDraftComposer);
  await assertAnchor(textareaSamples);
  expect((await bounds()).top).toBe(collapsed.top);
  expect((await anchorTick.boundingBox())!.y).toBe(tickTop);
  if (count === 80) {
    expect(await boxHeight(marks)).toBeLessThan(expandedHeight);
    expect(await marks.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
  }
}

async function readBottomDock(page: Page) {
  const sessionKey = "agent:main:main";
  await installMockGateway(page, {
    sessionKey,
    historyMessages: railMessages(
      80,
      "docked-rail",
      (index) => `Review checkpoint ${index + 1} and its supporting notes.`,
    ),
  });
  await page.addInitScript(createControlUiMockSameOriginGatewayScript());
  const settings = {
    sessionKey,
    sidebarSessionLayouts: {
      [sessionKey]: {
        columns: [
          {
            id: "side-panel-column",
            side: "right",
            panels: [{ id: "workspace", slot: "workspace" }],
            activePanelId: "workspace",
            height: 700,
            width: 480,
          },
        ],
        dock: "bottom",
        open: true,
        expanded: false,
      },
    },
  };
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
    value: settings,
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  await page.locator(".sidebar-region--bottom.sidebar-region--open").waitFor();
  const { transcript, track, marks } = chat(page);
  const first = marks.locator(".chat-position-rail__marker").first();
  await first.waitFor();
  await waitForChatScrollIdle(page);
  await transcript.hover();
  await page.mouse.wheel(0, -30000);
  await expect.poll(() => scrollTop(transcript)).toBe(0);
  await waitForChatScrollIdle(page);
  const top = (await track.boundingBox())!.y;
  await transcript.evaluate((element) => {
    element.scrollTop = 200;
  });
  await expect.poll(() => scrollTop(transcript)).toBe(200);
  expect((await track.boundingBox())!.y).toBe(top);
  await marks.evaluate((element) => {
    element.scrollTop = 0;
  });
  const preview = page.locator(".chat-position-rail__preview");
  for (const keyboard of [false, true]) {
    if (keyboard) {
      await page.mouse.move(900, 20);
      await transcript.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Home");
      await browserExpect(first).toBeFocused();
    } else {
      await first.hover();
    }
    await preview.waitFor();
    expect((await preview.boundingBox())!.y).toBeGreaterThanOrEqual(
      (await transcript.boundingBox())!.y,
    );
  }
}

suite.define(() => {
  it.each([
    { count: 1, direction: "ltr" },
    { count: 80, direction: "ltr" },
    { count: 80, direction: "rtl" },
  ])(
    "keeps the rail anchored as Details progress toggles and the composer grows ($count, $direction messages)",
    ({ count, direction }) => railPage((page) => keepRailAnchored(page, count, direction)),
  );
  it("keeps the rail and its first preview clear in a bottom-docked chat pane", () =>
    railPage(readBottomDock, { viewport: { width: 1440, height: 1440 }, reducedMotion: "reduce" }));
});
