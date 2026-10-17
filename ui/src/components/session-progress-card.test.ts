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

describe("renderSessionProgressCard", () => {
  it.each(["board", "composer"] as const)(
    "shows relative activity for %s cards with and without checklist steps",
    (placement) => {
      const container = createContainer();

      for (const steps of [progressCard.steps, undefined]) {
        render({ card: { ...progressCard, steps }, placement }, container);

        const timestamp = container.querySelector(".session-progress-card time");
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

  it.each([
    [undefined, "Updated 2m ago"],
    ["queued", "Updated 2m ago"],
    ["running", "Updated 2m ago"],
    ["done", "Updated 2m ago"],
    ["failed", "Updated 2m ago"],
    ["timeout", "Updated 2m ago"],
    ["killed", "Updated 2m ago"],
  ] as const)("maps canonical session status %s to %s", (status, expected) => {
    const container = mountCard({ sessionStatus: status });

    expect(container.querySelector("time")?.textContent).toBe(expected);
  });

  it("uses endedAt for terminal wording and falls back to Updated without it", () => {
    const container = mountCard({
      sessionStatus: "done",
      startedAt: RUN_STARTED_MS,
      endedAt: RUN_ENDED_MS,
    });
    expect(container.querySelector("time")?.textContent).toBe("Completed just now");
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(
      new Date(RUN_ENDED_MS).toISOString(),
    );

    render({ sessionStatus: "done" }, container);
    expect(container.querySelector("time")?.textContent).toBe("Updated 2m ago");
  });

  it("keeps disclosure attributes unchanged across progress snapshots", () => {
    const container = mountCard({});
    const details = container.querySelector("details")!;
    const observer = new MutationObserver(() => {});
    observer.observe(details, { attributes: true, attributeFilter: ["open", "data-reveal"] });
    render(
      {
        card: {
          ...progressCard,
          revision: 3,
          steps: [...progressCard.steps!, { step: "Updated progress", status: "pending" }],
        },
      },
      container,
    );
    expect(container.textContent).toContain("Updated progress");
    expect(observer.takeRecords()).toEqual([]);
    observer.disconnect();
  });

  it("refreshes relative time while connected and stops after disconnect", () => {
    const container = createContainer();
    const part = render({ card: { ...progressCard, updatedAt: NOW_MS - 10_000 } }, container);
    expect(container.querySelector("time")?.textContent).toBe("Updated just now");

    advance(60_000);
    expect(container.querySelector("time")?.textContent).toBe("Updated 1m ago");

    part.setPresented(false);
    advance(60_000);
    expect(container.querySelector("time")?.textContent).toBe("Updated 1m ago");

    render(null, container);
  });

  it("renders sanitized markdown and one accessible typed checklist", () => {
    const container = mountCard({ card: progressCard, placement: "board" });

    const card = container.querySelector(".session-progress-card");
    expect(card?.getAttribute("aria-label")).toBe("1 of 3 completed");
    expect(card?.querySelector("strong")?.textContent).toBe("Focused change");
    expect(card?.querySelector("progress")?.getAttribute("value")).toBe("1");
    expect(card?.querySelectorAll(".session-progress-card__count")).toHaveLength(0);
    expect(
      [...(card?.querySelectorAll(".session-progress-card__step") ?? [])].map((step) => ({
        label: step.getAttribute("aria-label"),
        marker: cardPart(step, "step-marker")?.innerHTML,
        status: [...step.classList].find((name) =>
          name.startsWith("session-progress-card__step--"),
        ),
      })),
    ).toEqual([
      {
        label: "Inspect the route, completed",
        marker: expect.stringContaining("<path"),
        status: "session-progress-card__step--completed",
      },
      {
        label: "Wire the checklist, in progress",
        marker: expect.stringContaining("session-run-spinner"),
        status: "session-progress-card__step--in_progress",
      },
      {
        label: "Run focused tests, pending",
        marker: expect.stringContaining("<polyline"),
        status: "session-progress-card__step--pending",
      },
    ]);
    expect(
      cardPart(card, "step--completed .session-progress-card__step-marker path"),
    ).not.toBeNull();
    expect(
      cardPart(card, "step--in_progress .session-progress-card__step-marker .session-run-spinner"),
    ).not.toBeNull();
    expect(
      cardPart(card, "step--pending .session-progress-card__step-marker polyline"),
    ).not.toBeNull();
  });

  it.each([
    ["in_progress", ".session-run-spinner"],
    ["pending", "polyline"],
  ] as const)("uses the %s marker in the composer summary", (status, markerSelector) => {
    const container = createContainer();
    const card = { ...progressCard, steps: [{ step: "Current step", status }] };
    render({ card }, container);

    expect(
      container.querySelector(
        `.session-progress-card__current-marker[data-status="${status}"] ${markerSelector}`,
      ),
    ).not.toBeNull();
  });

  it("presents durable in-progress work as paused without an active run", () => {
    const container = mountCard({ hasActiveRun: false });

    expect(container.querySelector(".session-run-spinner")).toBeNull();
    expect(
      container.querySelector('.session-progress-card__current-marker[data-status="paused"]'),
    ).not.toBeNull();
    const pausedStep = cardPart(container, "step--paused");
    expect(pausedStep?.getAttribute("aria-label")).toBe("Wire the checklist, paused");
    expect(pausedStep?.querySelector("polyline")).not.toBeNull();
  });

  it.each([
    ["stale", RUN_STARTED_MS - 1, "paused", false],
    ["current", RUN_STARTED_MS, "in_progress", true],
  ] as const)(
    "treats %s progress as current only after the active run starts",
    (_name, updatedAt, expectedStatus, expectedLive) => {
      const container = mountCard({
        card: { ...progressCard, updatedAt },
        sessionStatus: "running",
        startedAt: RUN_STARTED_MS,
        hasActiveRun: true,
      });

      expect(
        container.querySelector(
          `.session-progress-card__current-marker[data-status="${expectedStatus}"]`,
        ),
      ).not.toBeNull();
      expect(container.querySelector(".session-run-spinner") !== null).toBe(expectedLive);
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
        container.querySelector('.session-progress-card__current-marker[data-status="paused"]'),
      ).not.toBeNull();
      expect(cardPart(container, "step--paused")).not.toBeNull();
      expect(container.querySelector(".session-run-spinner")).toBeNull();
    },
  );

  it.each([
    ["stale", RUN_STARTED_MS - 1, "paused", false],
    ["current", RUN_STARTED_MS, "in_progress", true],
  ] as const)(
    "treats %s status-less progress as current only after the active run starts",
    (_name, updatedAt, expectedStatus, expectedLive) => {
      const container = mountCard({
        card: { ...progressCard, updatedAt },
        startedAt: RUN_STARTED_MS,
        hasActiveRun: true,
      });

      expect(
        container.querySelector(
          `.session-progress-card__current-marker[data-status="${expectedStatus}"]`,
        ),
      ).not.toBeNull();
      expect(container.querySelector(".session-run-spinner") !== null).toBe(expectedLive);
    },
  );

  it("keeps a disclosure affordance beside a completed dismissible composer card", () => {
    const container = createContainer();
    const completed = {
      ...progressCard,
      steps: progressCard.steps?.map(({ step }) => ({ step, status: "completed" as const })),
    };
    render({ card: completed, placement: "composer", onDismiss: () => undefined }, container);

    expect(cardPart(container, "options")).not.toBeNull();
    expect(cardPart(container, "chevron svg")).not.toBeNull();
  });

  it("opens active composer progress as a native disclosure without a progress bar", () => {
    const container = mountCard({
      card: { ...progressCard, markdown: "Working through the task." },
    });

    const card = container.querySelector<HTMLDetailsElement>(
      '[data-progress-card-placement="composer"]',
    );
    expect(card?.open).toBe(true);
    expect(card?.dataset.complete).toBe("false");
    expect(card?.querySelector("summary")?.getAttribute("aria-label")).toBe(
      "Wire the checklist. 1 of 3 completed",
    );
    expect(card?.querySelector("[role=region]")?.getAttribute("aria-label")).toBe(
      "1 of 3 completed",
    );
    expect(card?.querySelector("summary")?.textContent).toContain("Task progress");
    expect(
      card
        ?.querySelector(".session-progress-card__heading-actions")
        ?.textContent?.replaceAll(/\s+/gu, " ")
        .trim(),
    ).toBe("Step 2 of 3 · Updated 2m ago");
    expect(card?.querySelector("progress")).toBeNull();
    expect(card?.querySelectorAll(".session-progress-card__step")).toHaveLength(3);
  });

  it("collapses active composer progress when requested and preserves manual expansion", () => {
    const container = mountCard({ hasActiveRun: true, collapseComposerByDefault: true });

    const card = container.querySelector<HTMLDetailsElement>(
      '[data-progress-card-placement="composer"]',
    );
    expect(card?.open).toBe(false);
    card!.querySelector("summary")!.click();

    render(
      {
        card: { ...progressCard, revision: progressCard.revision + 1 },
        hasActiveRun: true,
        collapseComposerByDefault: true,
      },
      container,
    );
    expect(card?.open).toBe(true);
  });

  it("keeps the collapsed default at final unless manually opened", () => {
    const container = createContainer();
    const cardLifetime = {};
    const renderStatus = (sessionStatus: "running" | "done") =>
      render(
        {
          sessionStatus,
          startedAt: RUN_STARTED_MS,
          endedAt: sessionStatus === "done" ? RUN_ENDED_MS : undefined,
          hasActiveRun: sessionStatus === "running",
          collapseComposerByDefault: true,
          composerDisclosureContext: { cardLifetime },
        },
        container,
      );
    renderStatus("running");
    const card = container.querySelector("details")!;
    expect(card.open).toBe(false);
    renderStatus("done");
    expect(card.open).toBe(false);
    card.querySelector("summary")!.click();
    renderStatus("running");
    renderStatus("done");
    expect(card.open).toBe(true);
  });

  it.each([false, true])(
    "keeps settled history collapse through completion (final in history: %s)",
    async (finalInHistory) => {
      const container = createContainer();
      let currentCard = progressCard;
      const cardLifetime = {};
      const renderStatus = (
        readingHistory: boolean,
        sessionStatus: "running" | "done" = "running",
      ) =>
        render(
          {
            card: currentCard,
            sessionStatus,
            startedAt: RUN_STARTED_MS,
            endedAt: sessionStatus === "done" ? RUN_ENDED_MS : undefined,
            hasActiveRun: sessionStatus === "running",
            composerDisclosureContext: { cardLifetime, readingHistory },
            transcript: true,
          },
          container,
        );
      const wheel = (distance: number, pause = 0) => {
        advance(pause);
        transcript.wheel(distance);
      };
      renderStatus(true);
      const transcript = observeTranscript(container, transcriptCleanups);
      await Promise.resolve();
      const card = container.querySelector("details")!;
      expect(card.open).toBe(true);
      wheel(200);
      wheel(200, 201);
      advance(299);
      expect(card.open).toBe(true);
      if (finalInHistory) {
        transcript.thread.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp" }));
      }
      transcript.scroll(1);
      advance(299);
      expect(card.open).toBe(true);
      advance(1);
      expect(card.open).toBe(false);
      renderStatus(false);
      expect(card.open).toBe(false);
      currentCard = { ...progressCard, revision: 3, markdown: "Revised progress" };
      renderStatus(false);
      expect(card.open).toBe(false);
      currentCard = {
        ...currentCard,
        revision: 4,
        steps: currentCard.steps?.map(({ step }) => ({ step, status: "completed" as const })),
      };
      renderStatus(finalInHistory, "done");
      expect(card.open).toBe(false);
      renderStatus(false, "done");
      expect(card.open).toBe(false);
    },
  );

  it("keeps gestures across reading-history renders and late native offsets", async () => {
    const container = createContainer();
    const renderHistory = (readingHistory: boolean) =>
      renderTranscriptCard(container, { readingHistory });
    renderHistory(false);
    const transcript = observeTranscript(container, transcriptCleanups);
    await Promise.resolve();
    const card = container.querySelector("details")!;
    transcript.wheel(200);
    renderHistory(false);
    renderHistory(true);
    advance(299);
    transcript.thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
    advance(2);
    transcript.scroll(120);
    advance(300);
    expect(card.open).toBe(false);
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
    const card = container.querySelector("details")!;
    const root = container.querySelector(".chat-thread")!;
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
    const drag = (...points: number[]) => {
      touch("touchstart", points[0]);
      for (const point of points.slice(1)) {
        touch("touchmove", point);
      }
      touch("touchend", points.at(-1)!);
    };
    touch("touchstart", 0);
    touch("touchmove", 30);
    touch("touchmove", 160);
    advance(300);
    expect(card.open).toBe(true);
    touch("touchend", 160);
    touch("touchstart", 0);
    touch("touchmove", 30);
    advance(299);
    touch("touchmove", 160);
    advance(299);
    expect(card.open).toBe(true);
    advance(1);
    expect(card.open).toBe(true);
    touch("touchend", 160);
    expect(card.open).toBe(false);
    replaceCard();
    for (let index = 0; index < 2; index++) {
      drag(0, 160);
    }
    advance(100);
    touch("touchstart", 0);
    advance(200);
    expect(card.open).toBe(true);
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
    advance(300);
    expect(card.open).toBe(true);
    touch("touchend", 320);
    expect(card.open).toBe(true);
    drag(0, 25);
    advance(300);
    expect(card.open).toBe(false);
    replaceCard();
    for (let index = 0; index < 2; index++) {
      drag(300, 200, 450);
    }
    advance(300);
    expect(card.open).toBe(false);
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
    advance(300);
    expect(card.open).toBe(true);
    drag(0, 25);
    advance(300);
    expect(card.open).toBe(false);
    replaceCard();
    drag(0, 200);
    drag(0, 200);
    renderCard(false);
    await Promise.resolve();
    advance(300);
    expect(card.open).toBe(true);
    render(null, container);
    advance(300);
    expect(card.open).toBe(true);
    root.dispatchEvent(new WheelEvent("wheel", { deltaY: -500, bubbles: true }));
    advance(201);
    root.dispatchEvent(new WheelEvent("wheel", { deltaY: -500, bubbles: true }));
    advance(300);
    expect(card.open).toBe(true);
  });

  it("keeps the collapsed counter in the summary action column", () => {
    const container = mountCard({});

    const summary = cardPart(container, "summary");
    const count = cardPart(summary, "summary-count--collapsed");
    expect(count?.textContent?.trim()).toBe("2/3");
    expect(count?.parentElement).toBe(summary);
    expect(count?.previousElementSibling?.classList).toContain(
      "session-progress-card__summary-collapsed",
    );
    expect(count?.nextElementSibling?.classList).toContain(
      "session-progress-card__summary-expanded",
    );
  });

  it.each([
    ["running", "2/3"],
    ["done", "Completed"],
    ["failed", "Failed"],
    ["timeout", "Failed"],
    ["killed", "Stopped"],
  ] as const)("shows %s as %s in the closed summary", (status, expected) => {
    const container = mountCard({
      sessionStatus: status,
      startedAt: RUN_STARTED_MS,
      endedAt: RUN_ENDED_MS,
    });

    expect(cardPart(container, "summary-count--collapsed")?.textContent).toBe(expected);
  });

  it("uses a terminal circle-x instead of pausing after the run stops", () => {
    const container = mountCard({
      sessionStatus: "killed",
      startedAt: RUN_STARTED_MS,
      endedAt: RUN_ENDED_MS,
      hasActiveRun: false,
    });

    const indicator = cardPart(container, "summary-indicator");
    expect(container.querySelector(".session-run-spinner")).toBeNull();
    expect(indicator?.querySelector('circle[cx="12"][cy="12"][r="10"]')).not.toBeNull();
    expect(indicator?.querySelector('path[d="m15 9-6 6"]')).not.toBeNull();
    expect(indicator?.querySelector('path[d="m9 9 6 6"]')).not.toBeNull();
    expect(
      container.querySelector('.session-progress-card__step-marker[data-outcome="killed"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('.session-progress-card__step[aria-label$=", stopped"]'),
    ).not.toBeNull();
    expect(container.querySelector("summary")?.getAttribute("aria-label")).toBe(
      "Wire the checklist. Stopped",
    );
  });

  it("does not apply a later run outcome to an older progress card", () => {
    const container = mountCard({
      card: { ...progressCard, updatedAt: RUN_STARTED_MS - 1 },
      sessionStatus: "failed",
      startedAt: RUN_STARTED_MS,
      endedAt: RUN_ENDED_MS,
    });

    expect(container.querySelector("time")?.textContent).toBe("Updated 3m ago");
    expect(container.querySelector("[data-outcome=failed]")).toBeNull();
    expect(container.querySelector(".session-run-spinner")).toBeNull();
    expect(cardPart(container, "step--paused")).not.toBeNull();
  });

  it("renders a stale in-progress card as paused during a later active run", () => {
    const container = mountCard({
      card: { ...progressCard, updatedAt: RUN_STARTED_MS - 1 },
      placement: "board",
      sessionStatus: "running",
      startedAt: RUN_STARTED_MS,
      hasActiveRun: true,
    });

    expect(container.querySelector(".session-run-spinner")).toBeNull();
    const pausedStep = cardPart(container, "step--paused");
    expect(pausedStep).not.toBeNull();
    expect(pausedStep?.getAttribute("aria-label")).toBe("Wire the checklist, paused");
  });

  it("falls back safely for timestamps outside the Date range", () => {
    const container = mountCard({
      card: { ...progressCard, updatedAt: MAX_DATE_TIMESTAMP_MS + 1 },
      sessionStatus: "failed",
      startedAt: RUN_STARTED_MS,
      endedAt: MAX_DATE_TIMESTAMP_MS + 1,
    });

    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(
      new Date(NOW_MS).toISOString(),
    );
    expect(container.querySelector("[data-outcome=failed]")).toBeNull();
  });

  it.each([
    { mobile: false, collapseByDefault: false, open: true },
    { mobile: true, collapseByDefault: false, open: false },
    { mobile: false, collapseByDefault: true, open: false },
  ])(
    "uses presentation defaults for a completed card (mobile=$mobile, collapseByDefault=$collapseByDefault)",
    ({ mobile, collapseByDefault, open }) => {
      vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({ matches: mobile })),
      );
      const container = mountCard({
        card: {
          ...progressCard,
          steps: progressCard.steps?.map(({ step }) => ({ step, status: "completed" as const })),
        },
        sessionStatus: "done",
        startedAt: RUN_STARTED_MS,
        endedAt: RUN_ENDED_MS,
        hasActiveRun: false,
        collapseComposerByDefault: collapseByDefault,
        composerDisclosureContext: { cardLifetime: {} },
      });
      const card = container.querySelector("details")!;
      expect(card.open).toBe(open);
      expect(card.dataset.complete).toBe("true");
    },
  );

  it.each([
    ["pixels", 0, 160, false, false],
    ["lines", 1, 8, false, false],
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
      const container = createContainer();
      renderTranscriptCard(container, { readingHistory: true });
      const transcript = observeTranscript(container, transcriptCleanups);
      await Promise.resolve();
      const card = container.querySelector("details")!;
      transcript.wheel(500, { deltaMode, deltaY: -deltaY, ctrlKey }, offsetBeforeInput);
      advance(300);
      expect(card.open).toBe(true);
      if (scenario === "no TouchEvent constructor") {
        transcript.thread.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp" }));
      }
      transcript.wheel(200, { deltaMode, deltaY: -deltaY, ctrlKey }, offsetBeforeInput);
      advance(300);
      expect(card.open).toBe(ctrlKey);
      if (ctrlKey) {
        transcript.wheel(160);
        advance(300);
        expect(card.open).toBe(true);
        transcript.wheel(160);
        advance(300);
        expect(card.open).toBe(false);
      }
    },
  );

  it.each([false, true])(
    "counts a reversing wheel burst once, including a clamped pause: %s",
    async (clamped) => {
      const container = createContainer();
      renderTranscriptCard(container, { readingHistory: true });
      const transcript = observeTranscript(container, transcriptCleanups);
      await Promise.resolve();
      const card = container.querySelector("details")!;
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
      advance(300);
      expect(card.open).toBe(true);
      transcript.wheel(1);
      advance(300);
      expect(card.open).toBe(false);
    },
  );
});
