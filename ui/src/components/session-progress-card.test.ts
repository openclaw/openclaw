/* @vitest-environment jsdom */

import type { ProgressCard } from "@openclaw/gateway-protocol";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./markdown.ts", async () => {
  const actual = await vi.importActual<typeof import("./markdown.ts")>("./markdown.ts");
  return { ...actual, toSanitizedMarkdownHtml: vi.fn(actual.toSanitizedMarkdownHtml) };
});
import { toSanitizedMarkdownHtml } from "./markdown.ts";
import { observeTranscript } from "./session-progress-card.test-support.ts";
import { renderSessionProgressCard } from "./session-progress-card.ts";
import type { ComposerProgressRunLifecycle } from "./session-progress-disclosure-controller.ts";

const containers: HTMLDivElement[] = [];
function createContainer() {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  return container;
}

const transcriptCleanups: Array<() => void> = [];

const NOW_MS = Date.UTC(2026, 7, 26, 13, 37);
const RUN_STARTED_MS = NOW_MS - 3 * 60_000;
const RUN_ENDED_MS = NOW_MS - 30_000;

const progressCard: ProgressCard = {
  sessionKey: "agent:main:work",
  revision: 2,
  updatedAt: NOW_MS - 2 * 60_000,
  markdown: '**Focused change**\n\n<progress value="1" max="3"></progress>',
  steps: [
    { step: "Inspect the route", status: "completed" },
    { step: "Wire the checklist", status: "in_progress" },
    { step: "Run focused tests", status: "pending" },
  ],
};

function renderTranscriptCard(
  container: HTMLElement,
  lifecycle: ComposerProgressRunLifecycle,
  showTranscript = true,
) {
  return render(
    html`<div class="chat-main">
      ${showTranscript ? html`<div class="chat-thread"></div>` : nothing}
      ${renderSessionProgressCard(progressCard, "composer", undefined, undefined, undefined, undefined, true, false, lifecycle)}
    </div>`,
    container,
  );
}

describe("renderSessionProgressCard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    for (const cleanup of transcriptCleanups.splice(0)) {
      cleanup();
    }
    for (const container of containers.splice(0)) {
      render(nothing, container);
      container.remove();
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["board", "composer"] as const)(
    "shows relative activity for %s cards with and without checklist steps",
    (placement) => {
      const container = createContainer();

      for (const steps of [progressCard.steps, undefined]) {
        render(renderSessionProgressCard({ ...progressCard, steps }, placement), container);

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
    const container = createContainer();

    render(renderSessionProgressCard(progressCard, "composer", undefined, status), container);

    expect(container.querySelector("time")?.textContent).toBe(expected);
  });

  it("uses endedAt for terminal wording and falls back to Updated without it", () => {
    const container = createContainer();
    render(
      renderSessionProgressCard(
        progressCard,
        "composer",
        undefined,
        "done",
        RUN_STARTED_MS,
        RUN_ENDED_MS,
      ),
      container,
    );
    expect(container.querySelector("time")?.textContent).toBe("Completed just now");
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(
      new Date(RUN_ENDED_MS).toISOString(),
    );

    render(renderSessionProgressCard(progressCard, "composer", undefined, "done"), container);
    expect(container.querySelector("time")?.textContent).toBe("Updated 2m ago");
  });

  it("refreshes relative time while connected and stops after disconnect", () => {
    const container = createContainer();
    const part = render(
      renderSessionProgressCard({ ...progressCard, updatedAt: NOW_MS - 10_000 }, "composer"),
      container,
    );
    expect(container.querySelector("time")?.textContent).toBe("Updated just now");

    vi.advanceTimersByTime(60_000);
    expect(container.querySelector("time")?.textContent).toBe("Updated 1m ago");

    part.setConnected(false);
    vi.advanceTimersByTime(60_000);
    expect(container.querySelector("time")?.textContent).toBe("Updated 1m ago");

    render(null, container);
  });

  it("labels activity from the last minute as just now", () => {
    const container = createContainer();

    render(
      renderSessionProgressCard(
        { ...progressCard, updatedAt: NOW_MS - 10_000 },
        "composer",
        undefined,
        "running",
      ),
      container,
    );

    expect(container.querySelector("time")?.textContent).toBe("Updated just now");
  });

  it("renders sanitized markdown and one accessible typed checklist", () => {
    const container = createContainer();
    render(renderSessionProgressCard(progressCard, "board"), container);

    const card = container.querySelector(".session-progress-card");
    expect(card?.getAttribute("aria-label")).toBe("1 of 3 completed");
    expect(card?.querySelector("strong")?.textContent).toBe("Focused change");
    expect(card?.querySelector("progress")?.getAttribute("value")).toBe("1");
    expect(card?.querySelectorAll(".session-progress-card__count")).toHaveLength(0);
    expect(
      [...(card?.querySelectorAll(".session-progress-card__step") ?? [])].map((step) => ({
        label: step.getAttribute("aria-label"),
        marker: step.querySelector(".session-progress-card__step-marker")?.innerHTML,
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
      card?.querySelector(
        ".session-progress-card__step--completed .session-progress-card__step-marker path",
      ),
    ).not.toBeNull();
    expect(
      card?.querySelector(
        ".session-progress-card__step--in_progress .session-progress-card__step-marker .session-run-spinner",
      ),
    ).not.toBeNull();
    expect(
      card?.querySelector(
        ".session-progress-card__step--pending .session-progress-card__step-marker polyline",
      ),
    ).not.toBeNull();
  });

  it("reuses sanitized progress HTML across repeated render cycles", () => {
    const container = createContainer();
    const renderMarkdown = vi.mocked(toSanitizedMarkdownHtml);

    render(renderSessionProgressCard(progressCard, "board"), container);
    const firstHtml = container.querySelector(".session-progress-card__markdown")?.innerHTML;
    expect(renderMarkdown).toHaveBeenCalledTimes(1);

    render(renderSessionProgressCard(progressCard, "board"), container);
    expect(renderMarkdown).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".session-progress-card__markdown")?.innerHTML).toBe(firstHtml);

    render(
      renderSessionProgressCard({ ...progressCard, markdown: "**Updated progress**" }, "board"),
      container,
    );
    expect(renderMarkdown).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["in_progress", ".session-run-spinner"],
    ["pending", "polyline"],
  ] as const)("uses the %s marker in the composer summary", (status, markerSelector) => {
    const container = createContainer();
    const card = {
      ...progressCard,
      steps: [{ step: "Current step", status }],
    };
    render(renderSessionProgressCard(card, "composer"), container);

    expect(
      container.querySelector(
        `.session-progress-card__current-marker[data-status="${status}"] ${markerSelector}`,
      ),
    ).not.toBeNull();
  });

  it("presents durable in-progress work as paused without an active run", () => {
    const container = createContainer();
    render(
      renderSessionProgressCard(
        progressCard,
        "composer",
        undefined,
        undefined,
        undefined,
        undefined,
        false,
      ),
      container,
    );

    expect(container.querySelector(".session-run-spinner")).toBeNull();
    expect(
      container.querySelector('.session-progress-card__current-marker[data-status="paused"]'),
    ).not.toBeNull();
    const pausedStep = container.querySelector(".session-progress-card__step--paused");
    expect(pausedStep?.getAttribute("aria-label")).toBe("Wire the checklist, paused");
    expect(pausedStep?.querySelector("polyline")).not.toBeNull();
  });

  it.each([
    ["stale", RUN_STARTED_MS - 1, "paused", false],
    ["current", RUN_STARTED_MS, "in_progress", true],
  ] as const)(
    "treats %s progress as current only after the active run starts",
    (_name, updatedAt, expectedStatus, expectedLive) => {
      const container = createContainer();
      render(
        renderSessionProgressCard(
          { ...progressCard, updatedAt },
          "composer",
          undefined,
          "running",
          RUN_STARTED_MS,
          undefined,
          true,
        ),
        container,
      );

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
      const container = createContainer();
      render(
        renderSessionProgressCard(
          { ...progressCard, updatedAt: RUN_STARTED_MS - 1 },
          "composer",
          undefined,
          "queued",
          startedAt,
          endedAt,
          true,
        ),
        container,
      );

      expect(
        container.querySelector('.session-progress-card__current-marker[data-status="paused"]'),
      ).not.toBeNull();
      expect(container.querySelector(".session-progress-card__step--paused")).not.toBeNull();
      expect(container.querySelector(".session-run-spinner")).toBeNull();
    },
  );

  it.each([
    ["stale", RUN_STARTED_MS - 1, "paused", false],
    ["current", RUN_STARTED_MS, "in_progress", true],
  ] as const)(
    "treats %s status-less progress as current only after the active run starts",
    (_name, updatedAt, expectedStatus, expectedLive) => {
      const container = createContainer();
      render(
        renderSessionProgressCard(
          { ...progressCard, updatedAt },
          "composer",
          undefined,
          undefined,
          RUN_STARTED_MS,
          undefined,
          true,
        ),
        container,
      );

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
    render(
      renderSessionProgressCard(completed, "composer", () => undefined),
      container,
    );

    expect(container.querySelector(".session-progress-card__dismiss")).not.toBeNull();
    expect(container.querySelector(".session-progress-card__chevron svg")).not.toBeNull();
  });

  it("opens active composer progress as a native disclosure without a progress bar", () => {
    const container = createContainer();
    render(
      renderSessionProgressCard(
        { ...progressCard, markdown: "Working through the task." },
        "composer",
      ),
      container,
    );

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
    ).toBe("Updated 2m ago · 2 of 3");
    expect(card?.querySelector("progress")).toBeNull();
    expect(card?.querySelectorAll(".session-progress-card__step")).toHaveLength(3);
  });

  it("collapses active composer progress when requested and preserves manual expansion", () => {
    const container = createContainer();
    render(
      renderSessionProgressCard(
        progressCard,
        "composer",
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        true,
      ),
      container,
    );

    const card = container.querySelector<HTMLDetailsElement>(
      '[data-progress-card-placement="composer"]',
    );
    expect(card?.open).toBe(false);
    card!.querySelector("summary")!.click();

    render(
      renderSessionProgressCard(
        { ...progressCard, revision: progressCard.revision + 1 },
        "composer",
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        true,
      ),
      container,
    );
    expect(card?.open).toBe(true);
  });

  it("expands the collapsed default at final unless manually overridden", () => {
    const container = createContainer();
    const renderRun = (activeRunId: string | null, completedRunId: string | null) =>
      render(
        renderSessionProgressCard(
          progressCard,
          "composer",
          undefined,
          undefined,
          undefined,
          undefined,
          activeRunId !== null,
          true,
          { activeRunId, completedRunId },
        ),
        container,
      );
    renderRun("run-1", null);
    const card = container.querySelector("details")!;
    expect(card.open).toBe(false);
    renderRun(null, "run-1");
    expect(card.open).toBe(true);
    card.querySelector("summary")!.click();
    renderRun("run-2", null);
    renderRun(null, "run-2");
    expect(card.open).toBe(false);
  });

  it.each([false, true])(
    "waits for deliberate scrolling to settle and only reopens on final at the live end (final in history: %s)",
    async (finalInHistory) => {
      const container = createContainer();
      let currentCard = progressCard;
      const renderRun = (
        readingHistory: boolean,
        activeRunId: string | null = "run-1",
        completedRunId: string | null = null,
      ) =>
        render(
          html`<div class="chat-main">
            <div class="chat-thread"></div>
            ${renderSessionProgressCard(
              currentCard,
              "composer",
              undefined,
              activeRunId ? "running" : "done",
              RUN_STARTED_MS,
              completedRunId ? RUN_ENDED_MS : undefined,
              activeRunId !== null,
              false,
              { activeRunId, completedRunId, readingHistory },
            )}
          </div>`,
          container,
        );
      const wheel = (distance: number, pause = 0) => {
        vi.advanceTimersByTime(pause);
        transcript.wheel(distance);
      };
      renderRun(true);
      const transcript = observeTranscript(container, transcriptCleanups);
      await Promise.resolve();
      const card = container.querySelector("details")!;
      expect(card.open).toBe(true);
      wheel(200);
      wheel(200, 201);
      vi.advanceTimersByTime(299);
      expect(card.open).toBe(true);
      if (finalInHistory) {
        transcript.thread.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp" }));
      }
      transcript.scroll(1);
      vi.advanceTimersByTime(299);
      expect(card.open).toBe(true);
      vi.advanceTimersByTime(1);
      expect(card.open).toBe(false);
      renderRun(false);
      expect(card.open).toBe(false);
      currentCard = { ...progressCard, revision: 3, markdown: "Revised progress" };
      renderRun(false);
      expect(card.open).toBe(false);
      currentCard = {
        ...currentCard,
        revision: 4,
        steps: currentCard.steps?.map(({ step }) => ({ step, status: "completed" as const })),
      };
      renderRun(finalInHistory, null, "run-1");
      expect(card.open).toBe(!finalInHistory);
      renderRun(false, null, "run-1");
      expect(card.open).toBe(!finalInHistory);
    },
  );

  it("keeps gestures across reading-history renders and late native offsets", async () => {
    const container = createContainer();
    const renderHistory = (readingHistory: boolean) =>
      renderTranscriptCard(container, { activeRunId: "run-1", readingHistory });
    renderHistory(false);
    const transcript = observeTranscript(container, transcriptCleanups);
    await Promise.resolve();
    const card = container.querySelector("details")!;
    transcript.wheel(200);
    renderHistory(false);
    renderHistory(true);
    vi.advanceTimersByTime(299);
    transcript.thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
    vi.advanceTimersByTime(2);
    transcript.scroll(120);
    vi.advanceTimersByTime(300);
    expect(card.open).toBe(false);
  });

  it("counts each touch drag once, waits for scrolling to stop, and cancels on removal", async () => {
    const container = createContainer();
    const renderCard = (activeRunId: string, showTranscript = true) =>
      renderTranscriptCard(container, { activeRunId, readingHistory: true }, showTranscript);
    renderCard("run-1");
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
        new TouchEvent(type, {
          touches,
          targetTouches: touches,
          changedTouches,
          bubbles: true,
        }),
      );
      if (type === "touchmove" && contacts === 1) {
        transcript.scroll(y - previousY);
      }
    };
    touch("touchstart", 0);
    touch("touchmove", 30);
    touch("touchmove", 160);
    vi.advanceTimersByTime(300);
    expect(card.open).toBe(true);
    touch("touchend", 160);
    touch("touchstart", 0);
    touch("touchmove", 30);
    vi.advanceTimersByTime(299);
    touch("touchmove", 160);
    vi.advanceTimersByTime(299);
    expect(card.open).toBe(true);
    vi.advanceTimersByTime(1);
    expect(card.open).toBe(true);
    touch("touchend", 160);
    expect(card.open).toBe(false);
    card.querySelector("summary")!.click();
    renderCard("run-2");
    for (let drag = 0; drag < 2; drag++) {
      touch("touchstart", 0);
      touch("touchmove", 160);
      touch("touchend", 160);
    }
    vi.advanceTimersByTime(100);
    touch("touchstart", 0);
    vi.advanceTimersByTime(200);
    expect(card.open).toBe(true);
    touch("touchend", 0);
    expect(card.open).toBe(false);
    card.querySelector("summary")!.click();
    renderCard("run-3");
    touch("touchstart", 0);
    touch("touchmove", 320);
    touch("touchend", 320);
    touch("touchstart", 0);
    touch("touchmove", 30);
    touch("touchstart", 30, 2);
    touch("touchmove", 160, 2);
    touch("touchend", 160, 1);
    touch("touchmove", 320);
    vi.advanceTimersByTime(300);
    expect(card.open).toBe(true);
    touch("touchend", 320);
    expect(card.open).toBe(true);
    touch("touchstart", 0);
    touch("touchmove", 25);
    touch("touchend", 25);
    vi.advanceTimersByTime(300);
    expect(card.open).toBe(false);
    card.querySelector("summary")!.click();
    renderCard("run-4");
    for (let drag = 0; drag < 2; drag++) {
      touch("touchstart", 300);
      touch("touchmove", 200);
      touch("touchmove", 450);
      touch("touchend", 450);
    }
    vi.advanceTimersByTime(300);
    expect(card.open).toBe(false);
    card.querySelector("summary")!.click();
    renderCard("run-5");
    touch("touchstart", 0);
    touch("touchmove", 320);
    touch("touchend", 320);
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
    vi.advanceTimersByTime(300);
    expect(card.open).toBe(true);
    touch("touchstart", 0);
    touch("touchmove", 25);
    touch("touchend", 25);
    vi.advanceTimersByTime(300);
    expect(card.open).toBe(false);
    card.querySelector("summary")!.click();
    renderCard("run-6");
    touch("touchstart", 0);
    touch("touchmove", 200);
    touch("touchend", 200);
    touch("touchstart", 0);
    touch("touchmove", 200);
    touch("touchend", 200);
    renderCard("run-6", false);
    await Promise.resolve();
    vi.advanceTimersByTime(300);
    expect(card.open).toBe(true);
    render(nothing, container);
    vi.advanceTimersByTime(300);
    expect(card.open).toBe(true);
    root.dispatchEvent(new WheelEvent("wheel", { deltaY: -500, bubbles: true }));
    vi.advanceTimersByTime(201);
    root.dispatchEvent(new WheelEvent("wheel", { deltaY: -500, bubbles: true }));
    vi.advanceTimersByTime(300);
    expect(card.open).toBe(true);
  });

  it("keeps the collapsed counter in the summary action column", () => {
    const container = createContainer();
    render(renderSessionProgressCard(progressCard, "composer"), container);

    const summary = container.querySelector(".session-progress-card__summary");
    const count = summary?.querySelector(".session-progress-card__summary-count--collapsed");
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
    const container = createContainer();
    render(
      renderSessionProgressCard(
        progressCard,
        "composer",
        undefined,
        status,
        RUN_STARTED_MS,
        RUN_ENDED_MS,
      ),
      container,
    );

    expect(
      container.querySelector(".session-progress-card__summary-count--collapsed")?.textContent,
    ).toBe(expected);
  });

  it("uses a terminal circle-x instead of pausing after the run stops", () => {
    const container = createContainer();
    render(
      renderSessionProgressCard(
        progressCard,
        "composer",
        undefined,
        "killed",
        RUN_STARTED_MS,
        RUN_ENDED_MS,
        false,
      ),
      container,
    );

    const indicator = container.querySelector(".session-progress-card__summary-indicator");
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
    const container = createContainer();
    render(
      renderSessionProgressCard(
        { ...progressCard, updatedAt: RUN_STARTED_MS - 1 },
        "composer",
        undefined,
        "failed",
        RUN_STARTED_MS,
        RUN_ENDED_MS,
      ),
      container,
    );

    expect(container.querySelector("time")?.textContent).toBe("Updated 3m ago");
    expect(container.querySelector("[data-outcome=failed]")).toBeNull();
    expect(container.querySelector(".session-run-spinner")).toBeNull();
    expect(container.querySelector(".session-progress-card__step--paused")).not.toBeNull();
  });

  it("renders a stale in-progress card as paused during a later active run", () => {
    const container = createContainer();
    render(
      renderSessionProgressCard(
        { ...progressCard, updatedAt: RUN_STARTED_MS - 1 },
        "board",
        undefined,
        "running",
        RUN_STARTED_MS,
        undefined,
        true,
      ),
      container,
    );

    expect(container.querySelector(".session-run-spinner")).toBeNull();
    const pausedStep = container.querySelector(".session-progress-card__step--paused");
    expect(pausedStep).not.toBeNull();
    expect(pausedStep?.getAttribute("aria-label")).toBe("Wire the checklist, paused");
  });

  it("falls back safely for timestamps outside the Date range", () => {
    const container = createContainer();
    render(
      renderSessionProgressCard(
        { ...progressCard, updatedAt: MAX_DATE_TIMESTAMP_MS + 1 },
        "composer",
        undefined,
        "failed",
        RUN_STARTED_MS,
        MAX_DATE_TIMESTAMP_MS + 1,
      ),
      container,
    );

    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(
      new Date(NOW_MS).toISOString(),
    );
    expect(container.querySelector("[data-outcome=failed]")).toBeNull();
  });

  it("starts completed composer progress collapsed without replaying an old final", () => {
    const container = createContainer();
    render(
      renderSessionProgressCard(
        {
          ...progressCard,
          steps: progressCard.steps?.map((step) =>
            Object.assign({}, step, { status: "completed" as const }),
          ),
        },
        "composer",
        undefined,
        "done",
        RUN_STARTED_MS,
        RUN_ENDED_MS,
        false,
        true,
        { completedRunId: "run-before-mount" },
      ),
      container,
    );

    const card = container.querySelector<HTMLDetailsElement>(
      '[data-progress-card-placement="composer"]',
    );
    expect(card?.open).toBe(false);
    expect(card?.dataset.complete).toBe("true");
  });

  it("preserves the operator disclosure choice across progress updates", () => {
    const container = createContainer();
    render(renderSessionProgressCard(progressCard, "composer"), container);
    const card = container.querySelector<HTMLDetailsElement>(
      '[data-progress-card-placement="composer"]',
    );
    expect(card?.open).toBe(true);
    card!.querySelector("summary")!.click();

    render(
      renderSessionProgressCard(
        {
          ...progressCard,
          revision: progressCard.revision + 1,
          steps: progressCard.steps?.map((step, index) =>
            index === 1 ? { ...step, step: "Wire the updated checklist" } : step,
          ),
        },
        "composer",
      ),
      container,
    );

    expect(
      container.querySelector<HTMLDetailsElement>('[data-progress-card-placement="composer"]')
        ?.open,
    ).toBe(false);
  });

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
      renderTranscriptCard(container, { activeRunId: "run-1", readingHistory: true });
      const transcript = observeTranscript(container, transcriptCleanups);
      await Promise.resolve();
      const card = container.querySelector("details")!;
      transcript.wheel(500, { deltaMode, deltaY: -deltaY, ctrlKey }, offsetBeforeInput);
      vi.advanceTimersByTime(300);
      expect(card.open).toBe(true);
      if (scenario === "no TouchEvent constructor") {
        transcript.thread.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp" }));
      }
      transcript.wheel(200, { deltaMode, deltaY: -deltaY, ctrlKey }, offsetBeforeInput);
      vi.advanceTimersByTime(300);
      expect(card.open).toBe(ctrlKey);
      if (ctrlKey) {
        transcript.wheel(160);
        vi.advanceTimersByTime(300);
        expect(card.open).toBe(true);
        transcript.wheel(160);
        vi.advanceTimersByTime(300);
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
        vi.advanceTimersByTime(100);
      }
      if (clamped) {
        for (let index = 0; index < 4; index++) {
          transcript.thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -160, bubbles: true }));
          vi.advanceTimersByTime(100);
        }
        transcript.wheel(-40);
        vi.advanceTimersByTime(100);
        transcript.wheel(40);
      }
      vi.advanceTimersByTime(300);
      expect(card.open).toBe(true);
      transcript.wheel(1);
      vi.advanceTimersByTime(300);
      expect(card.open).toBe(false);
    },
  );

  it("preserves another pane's manual close after automatic collapse and remount", async () => {
    const first = createContainer();
    const second = createContainer();
    const lifecycle = { gatewayScope: {}, readingHistory: true };
    renderTranscriptCard(first, lifecycle);
    renderTranscriptCard(second, lifecycle);
    const transcript = observeTranscript(first, transcriptCleanups);
    await Promise.resolve();
    second.querySelector("summary")!.click();
    expect(second.querySelector("details")!.open).toBe(false);
    transcript.wheel(200);
    vi.advanceTimersByTime(201);
    transcript.wheel(200);
    vi.advanceTimersByTime(300);
    expect(first.querySelector("details")!.open).toBe(false);
    render(nothing, second);
    renderTranscriptCard(second, lifecycle);
    expect(second.querySelector("details")!.open).toBe(false);
  });

  it.each([
    { first: progressCard.sessionKey, next: "agent:main:next" },
    { first: "global", next: "agent:main:global" },
  ])(
    "remembers choices per Gateway and session across switching and remounting: $first",
    ({ first: session, next }) => {
      const container = createContainer();
      const gatewayA = {};
      const gatewayB = {};
      const renderCard = (gatewayScope: object, sessionKey = session) =>
        render(
          renderSessionProgressCard(
            {
              ...progressCard,
              sessionKey: sessionKey === "global" ? "agent:main:global" : sessionKey,
            },
            "composer",
            undefined,
            undefined,
            undefined,
            undefined,
            true,
            false,
            { gatewayScope, sessionIdentity: JSON.stringify(["main", sessionKey]) },
          ),
          container,
        );
      renderCard(gatewayA);
      const first = container.querySelector<HTMLDetailsElement>(
        '[data-progress-card-placement="composer"]',
      );
      first!.querySelector("summary")!.click();
      first!.open = true;
      first!.querySelector("summary")!.click();
      renderCard(gatewayA);
      expect(first!.open).toBe(false);

      renderCard(gatewayA, next);

      expect(
        container.querySelector<HTMLDetailsElement>('[data-progress-card-placement="composer"]')
          ?.open,
      ).toBe(true);
      renderCard(gatewayA);
      expect(container.querySelector("details")!.open).toBe(false);
      renderCard(gatewayB);
      expect(container.querySelector("details")!.open).toBe(true);
      renderCard(gatewayA);
      expect(container.querySelector("details")!.open).toBe(false);
      render(nothing, container);
      renderCard(gatewayA);
      expect(container.querySelector("details")!.open).toBe(false);
    },
  );
});
