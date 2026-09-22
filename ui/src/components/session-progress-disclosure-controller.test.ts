/* @vitest-environment jsdom */

import type { ProgressCard } from "@openclaw/gateway-protocol";
import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("elastic progress disclosure controller", () => {
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

  it.each([true, false])(
    "records endpoint wheel ownership and cancels following (collapsed=%s)",
    (collapsed) => {
      const container = createContainer();
      const onManipulate = vi.fn();
      const show = (final = false) =>
        render(
          renderSessionProgressCard(
            progressCard,
            "composer",
            undefined,
            undefined,
            undefined,
            undefined,
            !final,
            collapsed,
            {
              activeRunId: final ? null : "run-1",
              completedRunId: final ? "run-1" : null,
              onManipulate,
            },
          ),
          container,
        );
      show();
      const card = container.querySelector("details")!;
      const body = card.querySelector<HTMLElement>(".session-progress-card__body")!;
      if (!collapsed) {
        vi.spyOn(body, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 300));
      }
      card.querySelector("summary")!.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: collapsed ? 48 : -48,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(onManipulate).toHaveBeenCalledTimes(1);
      expect(body.style.height).toBe(collapsed ? "0px" : "300px");
      show(true);
      expect(card.open).toBe(!collapsed);
      expect(body.style.height).toBe(collapsed ? "0px" : "300px");
    },
  );

  it("holds a partial wheel choice across revisions and final, then resets it for a new task/session", () => {
    const container = createContainer();
    const show = (
      sessionKey: string,
      activeRunId: string | null,
      completedRunId: string | null,
      revision = 1,
    ) =>
      render(
        renderSessionProgressCard(
          { ...progressCard, sessionKey, revision },
          "composer",
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          true,
          { activeRunId, completedRunId },
        ),
        container,
      );
    show("agent:main:first", "one", null);
    const card = container.querySelector<HTMLDetailsElement>("details")!;
    const header = card.querySelector("summary")!;
    header.dispatchEvent(new WheelEvent("wheel", { deltaY: -48, bubbles: true, cancelable: true }));
    expect(card.open).toBe(true);
    expect(card.querySelector<HTMLElement>(".session-progress-card__body")!.style.height).toBe(
      "48px",
    );
    show("agent:main:first", "one", null, 2);
    show("agent:main:first", null, "one", 3);
    expect(card.querySelector<HTMLElement>(".session-progress-card__body")!.style.height).toBe(
      "48px",
    );
    show("agent:main:first", "two", null, 4);
    expect(card.open).toBe(false);
    header.dispatchEvent(new WheelEvent("wheel", { deltaY: -32, bubbles: true, cancelable: true }));
    expect(card.open).toBe(true);
    show("agent:main:second", "three", null);
    expect(card.open).toBe(false);
    expect(card.querySelector<HTMLElement>(".session-progress-card__body")!.style.height).toBe("");
  });

  it("remembers pixel choices only for the matching task, Gateway, and session identity", () => {
    const container = createContainer();
    const gateway = {};
    const show = (
      activeRunId: string | null,
      completedRunId: string | null = null,
      gatewayScope = gateway,
      sessionIdentity = "first",
    ) =>
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
          { gatewayScope, sessionIdentity, activeRunId, completedRunId },
        ),
        container,
      );
    const body = () => container.querySelector<HTMLElement>(".session-progress-card__body")!;
    show("one");
    container
      .querySelector("summary")!
      .dispatchEvent(new WheelEvent("wheel", { deltaY: -48, bubbles: true, cancelable: true }));
    render(nothing, container);
    show("one");
    expect(body().style.height).toBe("48px");
    render(nothing, container);
    show(null, "one");
    expect(body().style.height).toBe("48px");
    show(null, "one", {}, "first");
    expect(body().style.height).toBe("");
    show(null, "one", gateway, "second");
    expect(body().style.height).toBe("");
    show(null, "one");
    expect(body().style.height).toBe("48px");
    render(nothing, container);
    show("two");
    expect(body().style.height).toBe("");
    expect(container.querySelector("details")!.open).toBe(false);
  });

  it("header takeover clears pending transcript gestures before fresh history can collapse it", async () => {
    const container = createContainer();
    renderTranscriptCard(container, { activeRunId: "run-1", readingHistory: true });
    const transcript = observeTranscript(container, transcriptCleanups);
    await Promise.resolve();
    transcript.wheel(200);
    vi.advanceTimersByTime(201);
    transcript.wheel(200);
    const card = container.querySelector("details")!;
    const body = card.querySelector<HTMLElement>(".session-progress-card__body")!;
    card
      .querySelector("summary")!
      .dispatchEvent(new WheelEvent("wheel", { deltaY: -48, bubbles: true, cancelable: true }));
    vi.advanceTimersByTime(1000);
    expect(card.open).toBe(true);
    expect(body.style.height).toBe("48px");
    transcript.wheel(200);
    vi.advanceTimersByTime(301);
    expect(card.open).toBe(true);
    transcript.wheel(200);
    vi.advanceTimersByTime(301);
    expect(card.open).toBe(false);
    expect(body.style.height).toBe("");
  });
});
