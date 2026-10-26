/* @vitest-environment jsdom */

import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import {
  observeTranscript,
  cardPart,
  advance,
  NOW_MS,
  RUN_STARTED_MS,
  RUN_ENDED_MS,
  progressCard,
  progressCardFixture,
} from "./session-progress-card.test-support.tsx";
import type { ComposerProgressDisclosureContext } from "./session-progress-disclosure-binding.ts";

const { mountCard, createContainer, render, transcriptCleanups } = progressCardFixture();

function renderTranscriptCard(
  container: HTMLElement,
  context: ComposerProgressDisclosureContext,
  showTranscript = true,
) {
  return render(
    { composerDisclosureContext: context, transcript: true, showTranscript },
    container,
  );
}

// Identify the approved CircleDashed glyph independently of the production icon registry.
const pendingMarkerSelector = 'path[d="M10.1 2.182a10 10 0 0 1 3.8 0"]';

const runWindow = { startedAt: RUN_STARTED_MS, endedAt: RUN_ENDED_MS };
const query = (root: ParentNode | null | undefined, selector: string) =>
  root?.querySelector<HTMLElement>(selector);
const disclosure = (root: ParentNode) => root.querySelector("details")!;
function expectElements(
  root: ParentNode | null | undefined,
  present: boolean,
  ...selectors: string[]
) {
  for (const selector of selectors) {
    if (present) {
      expect(query(root, selector)).not.toBeNull();
    } else {
      expect(query(root, selector)).toBeNull();
    }
  }
}
function expectOpen(card: HTMLDetailsElement, open: boolean, elapsed: number) {
  advance(elapsed);
  expect(card.open).toBe(open);
}
async function mountTranscript(
  context: ComposerProgressDisclosureContext = { readingHistory: true },
) {
  const container = createContainer();
  renderTranscriptCard(container, context);
  const transcript = observeTranscript(container, transcriptCleanups);
  await Promise.resolve();
  return { container, transcript, card: disclosure(container) };
}

describe("renderSessionProgressCard", () => {
  it.each(["board", "composer"] as const)(
    "shows relative activity for %s cards with and without checklist steps",
    (placement) => {
      const container = createContainer();
      for (const steps of [progressCard.steps, undefined]) {
        render({ card: { ...progressCard, steps }, placement }, container);
        const timestamp = query(container, ".session-progress-card time");
        expect(timestamp?.getAttribute("datetime")).toBe(
          new Date(progressCard.updatedAt).toISOString(),
        );
        expect(timestamp?.textContent).toBe("Updated 2m ago");
        expect(timestamp?.getAttribute("aria-label")).toBe("Updated 2m ago");
        expect(timestamp?.getAttribute("title")).toBe(timestamp?.getAttribute("aria-label"));
        const accessibleCard =
          placement === "composer"
            ? timestamp?.closest("summary")
            : timestamp?.closest(".session-progress-card");
        expect(accessibleCard?.getAttribute("aria-label")).not.toContain("Updated");
      }
    },
  );

  it("shows saved activity for a running session without a start timestamp", () => {
    const container = mountCard({ sessionStatus: "running" });
    expect(query(container, "time")?.textContent).toBe("Updated 2m ago");
  });

  it("uses endedAt for terminal wording and falls back to Updated without it", () => {
    const container = mountCard({
      sessionStatus: "done",
      ...runWindow,
    });
    expect(query(container, "time")?.textContent).toBe("Completed just now");
    expect(query(container, "time")?.getAttribute("datetime")).toBe(
      new Date(RUN_ENDED_MS).toISOString(),
    );
    render({ sessionStatus: "done" }, container);
    expect(query(container, "time")?.textContent).toBe("Updated 2m ago");
  });

  it("refreshes relative time while connected and stops after disconnect", () => {
    const container = createContainer();
    const part = render({ card: { ...progressCard, updatedAt: NOW_MS - 10_000 } }, container);
    expect(query(container, "time")?.textContent).toBe("Updated just now");
    advance(60_000);
    expect(query(container, "time")?.textContent).toBe("Updated 1m ago");
    part.setPresented(false);
    advance(60_000);
    expect(query(container, "time")?.textContent).toBe("Updated 1m ago");
    render(null, container);
  });

  it("renders sanitized markdown and one accessible typed checklist", () => {
    const container = mountCard({ card: progressCard, placement: "board" });
    const card = query(container, ".session-progress-card");
    expect(card?.getAttribute("aria-label")).toBe("1 of 3 completed");
    expect(query(card, "strong")?.textContent).toBe("Focused change");
    expect(query(card, "progress")?.getAttribute("value")).toBe("1");
    expect(card?.querySelectorAll(".session-progress-card__count")).toHaveLength(0);
    const steps = card?.querySelectorAll(".session-progress-card__step") ?? [];
    expect(steps).toHaveLength(3);
    const expected = [
      ["Inspect the route, completed", "completed", "path"],
      ["Wire the checklist, in progress", "in_progress", ".session-run-spinner"],
      ["Run focused tests, pending", "pending", pendingMarkerSelector],
    ] as const;
    expected.forEach(([label, status, selector], index) => {
      const step = steps[index]!;
      expect(step.getAttribute("aria-label")).toBe(label);
      expect(
        [...step.classList].find((name) => name.startsWith("session-progress-card__step--")),
      ).toBe(`session-progress-card__step--${status}`);
      const marker = cardPart(step, "step-marker");
      expect(query(marker, selector)).not.toBeNull();
    });
  });

  it.each([
    ["in_progress", ".session-run-spinner"],
    ["pending", pendingMarkerSelector],
  ] as const)("uses the %s marker in the composer summary", (status, markerSelector) => {
    const container = createContainer();
    const card = { ...progressCard, steps: [{ step: "Current step", status }] };
    render({ card }, container);
    expect(
      query(
        container,
        `.session-progress-card__current-marker[data-status="${status}"] ${markerSelector}`,
      ),
    ).not.toBeNull();
  });

  it("presents durable in-progress work as paused without an active run", () => {
    const container = mountCard({ hasActiveRun: false });
    expectElements(container, false, ".session-run-spinner");
    expectElements(container, true, '.session-progress-card__current-marker[data-status="paused"]');
    const pausedStep = cardPart(container, "step--paused");
    expect(pausedStep?.getAttribute("aria-label")).toBe("Wire the checklist, paused");
    expect(pausedStep?.querySelector("polyline")).not.toBeNull();
  });

  it.each([
    ["running", RUN_STARTED_MS - 1, "paused", false],
    ["running", RUN_STARTED_MS, "in_progress", true],
    [undefined, RUN_STARTED_MS - 1, "paused", false],
    [undefined, RUN_STARTED_MS, "in_progress", true],
  ] as const)(
    "maps status %s and update %s to %s during an active run",
    (sessionStatus, updatedAt, expectedStatus, expectedLive) => {
      const container = mountCard({
        card: { ...progressCard, updatedAt },
        sessionStatus,
        startedAt: RUN_STARTED_MS,
        hasActiveRun: true,
      });
      expectElements(
        container,
        true,
        `.session-progress-card__current-marker[data-status="${expectedStatus}"]`,
      );
      expect(query(container, ".session-run-spinner") !== null).toBe(expectedLive);
    },
  );

  it.each([
    ["fresh", undefined, undefined],
    ["reused", RUN_STARTED_MS - 1_000, RUN_STARTED_MS],
  ] as const)(
    "pauses timestamped progress while a %s session run is queued",
    (_name, startedAt, endedAt) => {
      const container = mountCard({
        card: { ...progressCard, updatedAt: RUN_STARTED_MS - 1 },
        sessionStatus: "queued",
        startedAt,
        endedAt,
        hasActiveRun: true,
      });
      expect(
        query(container, '.session-progress-card__current-marker[data-status="paused"]'),
      ).not.toBeNull();
      expect(cardPart(container, "step--paused")).not.toBeNull();
      expectElements(container, false, ".session-run-spinner");
    },
  );

  it("keeps a disclosure affordance beside a completed dismissible composer card", () => {
    const container = createContainer();
    const completed = {
      ...progressCard,
      steps: progressCard.steps?.map(({ step }) => ({ step, status: "completed" as const })),
    };
    render({ card: completed, placement: "composer", onDismiss: () => undefined }, container);
    expect(disclosure(container).dataset.complete).toBe("true");
    expect(cardPart(container, "options")).not.toBeNull();
    expect(cardPart(container, "chevron svg")).not.toBeNull();
  });

  it("opens active composer progress as a native disclosure without a progress bar", () => {
    const container = mountCard({
      card: { ...progressCard, markdown: "Working through the task." },
    });
    const card = disclosure(container);
    expect(card?.open).toBe(true);
    expect(card?.dataset.complete).toBe("false");
    expect(query(card, "summary")?.getAttribute("aria-label")).toBe(
      "Wire the checklist. 1 of 3 completed",
    );
    expect(query(card, "[role=region]")?.getAttribute("aria-label")).toBe("1 of 3 completed");
    expect(query(card, "summary")?.textContent).toContain("Task progress");
    expect(
      card
        ?.querySelector(".session-progress-card__heading-actions")
        ?.textContent?.replaceAll(/\s+/gu, " ")
        .trim(),
    ).toBe("Step 2 of 3 · Updated 2m ago");
    expect(query(card, "progress")).toBeNull();
    expect(card?.querySelectorAll(".session-progress-card__step")).toHaveLength(3);
  });

  it("listens to its owned transcript instead of a closer pane's thread", async () => {
    const ownedPane = createContainer();
    const ownedThread = document.createElement("div");
    ownedThread.className = "chat-thread";
    ownedPane.append(ownedThread);
    const ownedTranscript = observeTranscript(ownedPane, transcriptCleanups);
    const container = createContainer();
    renderTranscriptCard(container, {
      readingHistory: true,
      getTranscriptElement: () => ownedThread,
    });
    const decoyTranscript = observeTranscript(container, transcriptCleanups);
    await Promise.resolve();
    const card = disclosure(container);
    expect(card.open).toBe(true);
    decoyTranscript.wheel(200);
    advance(201);
    decoyTranscript.wheel(200);
    expectOpen(card, true, 300);
    ownedTranscript.wheel(200);
    advance(201);
    ownedTranscript.wheel(200);
    expectOpen(card, false, 300);
  });

  it("keeps gestures across reading-history renders and late native offsets", async () => {
    const container = createContainer();
    const renderHistory = (readingHistory: boolean) =>
      renderTranscriptCard(container, { readingHistory });
    renderHistory(false);
    const transcript = observeTranscript(container, transcriptCleanups);
    await Promise.resolve();
    const card = disclosure(container);
    transcript.wheel(200);
    renderHistory(false);
    renderHistory(true);
    advance(299);
    transcript.thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
    advance(2);
    transcript.scroll(120);
    expectOpen(card, false, 300);
  });

  it("counts each touch drag once, waits for scrolling to stop, and cancels on removal", async () => {
    const container = createContainer();
    let cardLifetime = {};
    const renderCard = (showTranscript = true) =>
      renderTranscriptCard(container, { cardLifetime, readingHistory: true }, showTranscript);
    const replaceCard = () => {
      cardLifetime = {};
      renderCard();
    };
    renderCard();
    const transcript = observeTranscript(container, transcriptCleanups);
    await Promise.resolve();
    const card = disclosure(container);
    const root = query(container, ".chat-thread")!;
    let previousTouches: Touch[] = [];
    const touchPoint = (identifier: number, y: number, target: EventTarget = root): Touch => ({
      identifier,
      target,
      clientX: 0,
      clientY: y,
      pageX: 0,
      pageY: y,
      screenX: 0,
      screenY: y,
      radiusX: 1,
      radiusY: 1,
      rotationAngle: 0,
      force: 1,
    });
    const touch = (type: string, y: number, contacts = type === "touchend" ? 0 : 1) => {
      const previousY = previousTouches[0]?.clientY ?? y;
      const touches = Array.from({ length: contacts }, (_, index) => touchPoint(index + 1, y));
      const changedTouches =
        type === "touchend"
          ? previousTouches.filter(
              (previous) => !touches.some((next) => next.identifier === previous.identifier),
            )
          : type === "touchstart"
            ? touches.filter(
                (next) =>
                  !previousTouches.some((previous) => previous.identifier === next.identifier),
              )
            : touches;
      previousTouches = touches;
      root.dispatchEvent(
        new TouchEvent(type, { touches, targetTouches: touches, changedTouches, bubbles: true }),
      );
      if (type === "touchmove" && contacts === 1) {
        transcript.scroll(y - previousY);
      }
    };
    const drag = (...points: [number, ...number[]]) => {
      touch("touchstart", points[0]);
      for (const point of points.slice(1)) {
        touch("touchmove", point);
      }
      touch("touchend", points.at(-1)!);
    };
    touch("touchstart", 0);
    touch("touchmove", 30);
    touch("touchmove", 160);
    expectOpen(card, true, 300);
    touch("touchend", 160);
    touch("touchstart", 0);
    touch("touchmove", 30);
    advance(299);
    touch("touchmove", 160);
    expectOpen(card, true, 299);
    expectOpen(card, true, 1);
    touch("touchend", 160);
    expect(card.open).toBe(false);
    replaceCard();
    for (let index = 0; index < 2; index++) {
      drag(0, 160);
    }
    advance(100);
    touch("touchstart", 0);
    expectOpen(card, true, 200);
    touch("touchend", 0);
    expect(card.open).toBe(false);
    replaceCard();
    drag(0, 320);
    touch("touchstart", 0);
    touch("touchmove", 30);
    touch("touchstart", 30, 2);
    touch("touchmove", 160, 2);
    touch("touchend", 160, 1);
    touch("touchmove", 320);
    expectOpen(card, true, 300);
    touch("touchend", 320);
    expect(card.open).toBe(true);
    drag(0, 25);
    expectOpen(card, false, 300);
    replaceCard();
    for (let index = 0; index < 2; index++) {
      drag(300, 200, 450);
    }
    expectOpen(card, false, 300);
    replaceCard();
    drag(0, 320);
    touch("touchstart", 0);
    touch("touchmove", 200);
    root.dispatchEvent(
      new TouchEvent("touchend", {
        touches: [touchPoint(99, 200, container)],
        targetTouches: [],
        changedTouches: previousTouches,
        bubbles: true,
      }),
    );
    previousTouches = [];
    expectOpen(card, true, 300);
    drag(0, 25);
    expectOpen(card, false, 300);
    replaceCard();
    drag(0, 200);
    drag(0, 200);
    renderCard(false);
    await Promise.resolve();
    expectOpen(card, true, 300);
    render(null, container);
    expectOpen(card, true, 300);
    root.dispatchEvent(new WheelEvent("wheel", { deltaY: -500, bubbles: true }));
    advance(201);
    root.dispatchEvent(new WheelEvent("wheel", { deltaY: -500, bubbles: true }));
    expectOpen(card, true, 300);
  });

  it.each([
    ["running", "2/3"],
    ["done", "Completed"],
    ["failed", "Failed"],
    ["timeout", "Failed"],
    ["killed", "Stopped"],
  ] as const)("announces %s as %s in collapsed progress summaries", (status, expected) => {
    for (const placement of ["composer", "details"] as const) {
      const container = mountCard({
        placement,
        desktopDetails: placement === "details",
        collapseComposerByDefault: true,
        sessionStatus: status,
        ...runWindow,
      });
      expect(disclosure(container).open).toBe(false);
      expect(query(container, "summary")?.getAttribute("aria-label")).toBe(
        `Wire the checklist. ${status === "running" ? "1 of 3 completed" : expected}`,
      );
      if (placement === "composer") {
        expect(
          query(container, "summary > .session-progress-card__summary-count--collapsed")
            ?.textContent,
        ).toBe(expected);
      }
    }
  });

  it("uses a terminal circle-x instead of pausing after the run stops", () => {
    const container = mountCard({
      sessionStatus: "killed",
      ...runWindow,
      hasActiveRun: false,
    });
    const indicator = cardPart(container, "summary-indicator");
    expect(query(container, ".session-run-spinner")).toBeNull();
    expectElements(
      indicator,
      true,
      'circle[cx="12"][cy="12"][r="10"]',
      'path[d="m15 9-6 6"]',
      'path[d="m9 9 6 6"]',
    );
    expectElements(container, true, '.session-progress-card__step-marker[data-outcome="killed"]');
    expectElements(container, true, '.session-progress-card__step[aria-label$=", stopped"]');
    expect(query(container, "summary")?.getAttribute("aria-label")).toBe(
      "Wire the checklist. Stopped",
    );
  });

  it("does not apply a later run outcome to an older progress card", () => {
    const container = mountCard({
      card: { ...progressCard, updatedAt: RUN_STARTED_MS - 1 },
      sessionStatus: "failed",
      ...runWindow,
    });
    expect(query(container, "time")?.textContent).toBe("Updated 3m ago");
    expect(query(container, "[data-outcome=failed]")).toBeNull();
    expectElements(container, false, ".session-run-spinner");
    expect(cardPart(container, "step--paused")).not.toBeNull();
  });

  it("falls back safely for timestamps outside the Date range", () => {
    const container = mountCard({
      card: { ...progressCard, updatedAt: MAX_DATE_TIMESTAMP_MS + 1 },
      sessionStatus: "failed",
      startedAt: RUN_STARTED_MS,
      endedAt: MAX_DATE_TIMESTAMP_MS + 1,
    });
    expect(query(container, "time")?.getAttribute("datetime")).toBe(new Date(NOW_MS).toISOString());
    expect(query(container, "[data-outcome=failed]")).toBeNull();
  });

  it.each([
    ["pages", 2, 0.8, false, false],
    ["zoom", 0, 160, true, false],
    ["native offset before input", 0, 200, false, true],
    ["no TouchEvent constructor", 0, 200, false, false],
  ] as const)(
    "uses consumed offsets regardless of wheel units and ignores zoom (%s)",
    async (scenario, deltaMode, deltaY, ctrlKey, offsetBeforeInput) => {
      if (scenario === "no TouchEvent constructor") {
        vi.stubGlobal("TouchEvent", undefined);
      }
      const { transcript, card } = await mountTranscript();
      transcript.wheel(500, { deltaMode, deltaY: -deltaY, ctrlKey }, offsetBeforeInput);
      expectOpen(card, true, 300);
      if (scenario === "no TouchEvent constructor") {
        transcript.thread.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp" }));
      }
      transcript.wheel(200, { deltaMode, deltaY: -deltaY, ctrlKey }, offsetBeforeInput);
      advance(300);
      expect(card.open).toBe(ctrlKey);
      if (ctrlKey) {
        transcript.wheel(160);
        expectOpen(card, true, 300);
        transcript.wheel(160);
        expectOpen(card, false, 300);
      }
    },
  );

  it.each([false, true])(
    "counts a reversing wheel burst once, including a clamped pause: %s",
    async (clamped) => {
      const { transcript, card } = await mountTranscript();
      for (const deltaY of [40, -160, 40, 40, -160]) {
        transcript.wheel(-deltaY);
        advance(100);
      }
      if (clamped) {
        for (let index = 0; index < 4; index++) {
          transcript.thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -160, bubbles: true }));
          advance(100);
        }
        transcript.wheel(-40);
        advance(100);
        transcript.wheel(40);
      }
      expectOpen(card, true, 300);
      transcript.wheel(1);
      expectOpen(card, false, 300);
    },
  );
});
