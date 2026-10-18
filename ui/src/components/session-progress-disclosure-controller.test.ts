/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { publishTranscriptScroll } from "../pages/chat/components/chat-transcript-scroll-events.ts";
import {
  observeTranscript,
  cardPart,
  advance,
  RUN_STARTED_MS,
  RUN_ENDED_MS,
  progressCard,
  progressCardFixture,
} from "./session-progress-card.test-support.tsx";
import type { ComposerProgressDisclosureContext } from "./session-progress-disclosure-binding.ts";

const { createView, transcriptCleanups } = progressCardFixture();

function disclosure(context: ComposerProgressDisclosureContext = {}, collapsed = false) {
  const { container, show: render } = createView({
    startedAt: RUN_STARTED_MS,
    collapseComposerByDefault: collapsed,
    transcript: true,
  });
  const card = () => container.querySelector("details")!;
  const body = () => cardPart(container, "body")!;
  return {
    container,
    card,
    body,
    unmount: () => render(null),
    show: (value = progressCard, status: "running" | "done" = "running", lifecycle = context) =>
      render({
        card: value,
        sessionStatus: status,
        endedAt: status === "done" ? RUN_ENDED_MS : undefined,
        hasActiveRun: status === "running",
        composerDisclosureContext: lifecycle,
      }),
    click: () => card().querySelector("summary")!.click(),
    wheel(deltaY: number, bubbles = true) {
      const event = new WheelEvent("wheel", { deltaY, bubbles, cancelable: true });
      card().querySelector("summary")!.dispatchEvent(event);
      return event.defaultPrevented;
    },
    expectChoice(this: void, open: boolean, height = "") {
      expect(card()).toMatchObject({ open });
      expect(body().style.height).toBe(height);
    },
  };
}

function wheelThenAdvance(transcript: ReturnType<typeof observeTranscript>, ms = 301) {
  transcript.wheel(200);
  advance(ms);
}

it("parks disclosure gestures and restores the retained choice on reveal", () => {
  const fixture = disclosure({ cardLifetime: {} });
  const view = fixture.show();
  const body = fixture.body();
  expect(fixture.wheel(-48)).toBe(true);
  const chosenHeight = body.style.height;
  view.setPresented(false);
  expect(fixture.wheel(-48)).toBe(false);
  view.setPresented(true);
  expect(body.style.height).toBe(chosenHeight);
  expect(fixture.wheel(-48)).toBe(true);
});

it.each([
  { mobile: false, partial: false, retained: true },
  { mobile: true, partial: false, retained: true },
  { mobile: false, partial: true, retained: true },
  { mobile: false, partial: false, retained: false },
])(
  "retains choice: mobile=$mobile partial=$partial lifetime=$retained",
  ({ mobile, partial, retained }) => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: mobile })),
    );
    const gatewayScope = {};
    const cardLifetime = {};
    const fixture = disclosure({}, partial);
    const show = (lifetime = cardLifetime, revision = 2, final = false) =>
      fixture.show(
        {
          ...progressCard,
          revision,
          steps:
            final && !partial
              ? progressCard.steps?.map(({ step }) => ({ step, status: "completed" as const }))
              : progressCard.steps,
        },
        final ? "done" : "running",
        {
          gatewayScope,
          sessionIdentity: "same-session",
          cardLifetime: retained ? lifetime : undefined,
        },
      );
    const initialOpen = !mobile && !partial;
    const manualOpen = mobile || partial;
    const { expectChoice } = fixture;
    show();
    expectChoice(initialOpen);
    if (partial) {
      fixture.wheel(-48);
    } else {
      fixture.click();
    }
    expectChoice(manualOpen, partial ? "48px" : "");
    show();
    expectChoice(manualOpen, partial ? "48px" : "");
    let remounted = false;
    for (const [revision, final, remount] of [
      [3, false, false],
      [4, true, false],
      [4, true, true],
      [5, false, false],
    ] as const) {
      if (remount) {
        fixture.unmount();
        remounted = true;
      }
      show(cardLifetime, revision, final);
      expectChoice(!retained && remounted ? initialOpen : manualOpen, partial ? "48px" : "");
    }
    const replacement = {};
    show(replacement, 1);
    expectChoice(initialOpen);
    expect(fixture.body().style.minHeight).toBe("");
    fixture.unmount();
    show(replacement, 1);
    expectChoice(initialOpen);
  },
);

it.each([
  "history",
  "delayed history",
  "keyboard replacement",
  "pointer replacement",
  "programmatic replacement",
  "scope replacement",
  "header",
] as const)("retains %s collapse through revisions, completion, and remount", async (choice) => {
  const context = { gatewayScope: {}, cardLifetime: {}, readingHistory: true };
  const fixture = disclosure(context);
  fixture.show();
  if (choice !== "header") {
    const transcript = observeTranscript(fixture.container, transcriptCleanups);
    await Promise.resolve();
    if (choice !== "history") {
      transcript.thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -200, bubbles: true }));
      advance(301);
      expect(fixture.card().open).toBe(true);
      if (choice === "keyboard replacement") {
        transcript.thread.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
      } else if (choice === "pointer replacement") {
        transcript.thread.dispatchEvent(new PointerEvent("pointerdown"));
      } else if (choice === "programmatic replacement") {
        publishTranscriptScroll(transcript.thread, {
          type: "offset",
          delta: 0,
          scrolling: false,
          touching: false,
          programmatic: true,
        });
      } else if (choice === "scope replacement") {
        context.gatewayScope = {};
        fixture.show();
        await Promise.resolve();
      }
      transcript.scroll(200);
      if (choice !== "delayed history") {
        advance(301);
        expect(fixture.card().open).toBe(true);
        wheelThenAdvance(transcript);
        expect(fixture.card().open).toBe(true);
      }
    } else {
      transcript.wheel(200);
    }
    advance(201);
    wheelThenAdvance(transcript);
  } else {
    fixture.wheel(400, false);
  }
  expect(fixture.card().open).toBe(false);
  context.readingHistory = false;
  const revised = { ...progressCard, revision: 3, markdown: "Revised progress" };
  for (const [status, remount] of [
    ["running", false],
    ["done", false],
    ["done", true],
  ] as const) {
    if (remount) {
      fixture.unmount();
    }
    fixture.show(revised, status);
    expect(fixture.card().open).toBe(false);
  }
  fixture.show({ ...revised, revision: 4 });
  expect(fixture.card().open).toBe(false);
  fixture.click();
  fixture.show({ ...revised, revision: 5 });
  expect(fixture.card().open).toBe(true);
});

it.each([true, false])("owns endpoint wheel and cancels following: collapsed=%s", (collapsed) => {
  const onManipulate = vi.fn();
  const fixture = disclosure({ onManipulate }, collapsed);
  fixture.show();
  const body = fixture.body();
  if (!collapsed) {
    vi.spyOn(body, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 300));
  }
  fixture.wheel(collapsed ? 48 : -48);
  expect(onManipulate).toHaveBeenCalledTimes(1);
  expect(body.style.height).toBe(collapsed ? "" : "300px");
  fixture.show(progressCard, "done");
  fixture.expectChoice(!collapsed, collapsed ? "" : "300px");
});

it("does not let a stale pane's old card overwrite the replacement card's choice", () => {
  const context = { gatewayScope: {}, sessionIdentity: "same-session", cardLifetime: {} };
  const current = disclosure(context);
  const stale = disclosure(context);
  current.show();
  stale.show();
  const replacement = { ...context, cardLifetime: {} };
  current.show({ ...progressCard, revision: 1 }, "running", replacement);
  current.click();
  expect(current.card().open).toBe(false);
  stale.click();
  stale.click();
  expect(stale.card().open).toBe(true);
  current.unmount();
  current.show({ ...progressCard, revision: 1 }, "running", replacement);
  expect(current.card().open).toBe(false);
});

it.each(["hidden", "header"])(
  "%s takeover requires fresh gestures before collapse",
  async (takeover) => {
    const cardLifetime = takeover === "hidden" ? {} : undefined;
    const fixture = disclosure();
    const show = (presented: boolean) =>
      fixture.show(progressCard, "running", { cardLifetime, readingHistory: true, presented });
    show(true);
    const transcript = observeTranscript(fixture.container, transcriptCleanups);
    await Promise.resolve();
    const card = fixture.card();
    wheelThenAdvance(transcript, 201);
    transcript.wheel(200);

    if (takeover === "hidden") {
      show(false);
      await Promise.resolve();
    } else {
      fixture.wheel(-48);
    }
    advance(1000);
    fixture.expectChoice(true, takeover === "header" ? "48px" : "");
    if (takeover === "hidden") {
      wheelThenAdvance(transcript);
      wheelThenAdvance(transcript);
      expect(card.open).toBe(true);
      show(true);
      await Promise.resolve();
      expect(fixture.card()).toBe(card);
    }
    wheelThenAdvance(transcript);
    expect(card.open).toBe(true);
    wheelThenAdvance(transcript);
    fixture.expectChoice(false);
  },
);
it("preserves another pane's newer manual reopen after stale automatic collapse and remount", async () => {
  const context = { gatewayScope: {}, cardLifetime: {}, readingHistory: true };
  const first = disclosure(context);
  const second = disclosure(context);
  first.show();
  second.show();
  const transcript = observeTranscript(first.container, transcriptCleanups);
  await Promise.resolve();
  second.click();
  second.click();
  expect(second.card().open).toBe(true);
  wheelThenAdvance(transcript, 201);
  wheelThenAdvance(transcript, 300);
  expect(first.card().open).toBe(false);
  second.unmount();
  second.show();
  expect(second.card().open).toBe(true);
});

it.each([
  { first: progressCard.sessionKey, next: "agent:main:next" },
  { first: "global", next: "agent:main:global" },
])(
  "retains authority across Gateway/session switches and remount: $first",
  ({ first: session, next }) => {
    const fixture = createView({ hasActiveRun: true, collapseComposerByDefault: false });
    const gatewayA = {};
    const gatewayB = {};
    const firstLifetime = {};
    const nextLifetime = {};
    const otherGatewayLifetime = {};
    const renderCard = (gatewayScope: object, sessionKey = session) =>
      fixture.show({
        card: {
          ...progressCard,
          sessionKey: sessionKey === "global" ? "agent:main:global" : sessionKey,
        },
        composerDisclosureContext: {
          gatewayScope,
          sessionIdentity: JSON.stringify(["main", sessionKey]),
          cardLifetime:
            gatewayScope === gatewayB
              ? otherGatewayLifetime
              : sessionKey === session
                ? firstLifetime
                : nextLifetime,
        },
      });
    renderCard(gatewayA);
    const card = () => fixture.container.querySelector("details")!;
    const first = card();
    first.querySelector("summary")!.click();
    first.open = true;
    first.querySelector("summary")!.click();
    renderCard(gatewayA);
    expect(first.open).toBe(false);
    for (const [gateway, sessionKey, open] of [
      [gatewayA, next, true],
      [gatewayA, session, false],
      [gatewayB, session, true],
      [gatewayA, session, false],
    ] as const) {
      renderCard(gateway, sessionKey);
      expect(card().open).toBe(open);
    }
    fixture.show(null);
    renderCard(gatewayA);
    expect(card().open).toBe(false);
  },
);
