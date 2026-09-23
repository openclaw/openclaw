/* @vitest-environment jsdom */

import type { ProgressCard } from "@openclaw/gateway-protocol";
import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeTranscript } from "./session-progress-card.test-support.ts";
import { renderSessionProgressCard } from "./session-progress-card.ts";
import type { ComposerProgressDisclosureContext } from "./session-progress-disclosure-controller.ts";

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
  context: ComposerProgressDisclosureContext,
  card = progressCard,
  sessionStatus: "running" | "done" = "running",
) {
  return render(
    html`<div class="chat-main">
      <div class="chat-thread"></div>
      ${renderSessionProgressCard(card, "composer", undefined, sessionStatus, RUN_STARTED_MS, sessionStatus === "done" ? RUN_ENDED_MS : undefined, sessionStatus === "running", false, context)}
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

  it.each([false, true])(
    "uses fresh-card defaults and retains the opposite manual choice (mobile=%s)",
    (mobile) => {
      vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({ matches: mobile })),
      );
      const container = createContainer();
      const gatewayScope = {};
      const cardLifetime = {};
      const show = (lifetime = cardLifetime, revision = 2, final = false) =>
        renderTranscriptCard(
          container,
          { gatewayScope, cardLifetime: lifetime },
          {
            ...progressCard,
            revision,
            steps: final
              ? progressCard.steps?.map(({ step }) => ({ step, status: "completed" as const }))
              : progressCard.steps,
          },
          final ? "done" : "running",
        );
      show();
      let card = container.querySelector("details")!;
      expect(card.open).toBe(!mobile);
      card.querySelector("summary")!.click();
      expect(card.open).toBe(mobile);
      show(cardLifetime, 3);
      expect(card.open).toBe(mobile);
      show(cardLifetime, 4, true);
      expect(card.open).toBe(mobile);
      render(nothing, container);
      show(cardLifetime, 4, true);
      card = container.querySelector("details")!;
      expect(card.open).toBe(mobile);
      show(cardLifetime, 5);
      expect(card.open).toBe(mobile);
      const replacement = {};
      show(replacement, 1);
      expect(card.open).toBe(!mobile);
      render(nothing, container);
      show(replacement, 1);
      expect(container.querySelector("details")!.open).toBe(!mobile);
    },
  );

  it.each(["history", "header"] as const)(
    "retains a %s collapse through revisions, completion, and remount",
    async (choice) => {
      const container = createContainer();
      const context = { gatewayScope: {}, cardLifetime: {}, readingHistory: true };
      renderTranscriptCard(container, context);
      let card = container.querySelector("details")!;
      const summary = card.querySelector("summary")!;
      if (choice === "history") {
        const transcript = observeTranscript(container, transcriptCleanups);
        await Promise.resolve();
        transcript.wheel(200);
        vi.advanceTimersByTime(201);
        transcript.wheel(200);
        vi.advanceTimersByTime(301);
      } else {
        summary.dispatchEvent(new WheelEvent("wheel", { deltaY: 400, cancelable: true }));
      }
      expect(card.open).toBe(false);
      context.readingHistory = false;
      const revised = { ...progressCard, revision: 3, markdown: "Revised progress" };
      renderTranscriptCard(container, context, revised);
      expect(card.open).toBe(false);
      renderTranscriptCard(container, context, revised, "done");
      expect(card.open).toBe(false);
      render(nothing, container);
      renderTranscriptCard(container, context, revised, "done");
      card = container.querySelector("details")!;
      expect(card.open).toBe(false);
      renderTranscriptCard(container, context, { ...revised, revision: 4 });
      expect(card.open).toBe(false);
      card.querySelector("summary")!.click();
      renderTranscriptCard(container, context, { ...revised, revision: 5 });
      expect(card.open).toBe(true);
    },
  );

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
            final ? "done" : "running",
            RUN_STARTED_MS,
            final ? RUN_ENDED_MS : undefined,
            !final,
            collapsed,
            {
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
      expect(body.style.height).toBe(collapsed ? "" : "300px");
      show(true);
      expect(card.open).toBe(!collapsed);
      expect(body.style.height).toBe(collapsed ? "" : "300px");
    },
  );

  it("retains partial extent for one card across revisions, run status, and remount, but not replacement", () => {
    const container = createContainer();
    const cardLifetime = {};
    const show = (lifetime = cardLifetime, revision = 2, final = false) =>
      render(
        renderSessionProgressCard(
          { ...progressCard, revision },
          "composer",
          undefined,
          final ? "done" : "running",
          RUN_STARTED_MS,
          final ? RUN_ENDED_MS : undefined,
          !final,
          true,
          { cardLifetime: lifetime },
        ),
        container,
      );
    const body = () => container.querySelector<HTMLElement>(".session-progress-card__body")!;
    show();
    container
      .querySelector("summary")!
      .dispatchEvent(new WheelEvent("wheel", { deltaY: -48, bubbles: true, cancelable: true }));
    expect(container.querySelector("details")!.open).toBe(true);
    expect(body().style.height).toBe("48px");
    show(cardLifetime, 3);
    expect(body().style.height).toBe("48px");
    show(cardLifetime, 4, true);
    expect(body().style.height).toBe("48px");
    render(nothing, container);
    show(cardLifetime, 4, true);
    expect(body().style.height).toBe("48px");
    show(cardLifetime, 5);
    expect(body().style.height).toBe("48px");
    expect(container.querySelector("details")!.open).toBe(true);
    const replacement = {};
    show(replacement, 1);
    expect(container.querySelector("details")!.open).toBe(false);
    expect(body().style.height).toBe("");
    expect(body().style.minHeight).toBe("");
    render(nothing, container);
    show(replacement, 1);
    expect(container.querySelector("details")!.open).toBe(false);
    expect(body().style.height).toBe("");
  });

  it("does not retain choices across remount without an authoritative card lifetime", () => {
    const container = createContainer();
    const context = { gatewayScope: {}, sessionIdentity: "same-session" };
    renderTranscriptCard(container, context);
    container.querySelector("summary")!.click();
    renderTranscriptCard(container, context);
    expect(container.querySelector("details")!.open).toBe(false);
    render(nothing, container);
    renderTranscriptCard(container, context);
    expect(container.querySelector("details")!.open).toBe(true);
  });

  it("does not let a stale pane's old card overwrite the replacement card's choice", () => {
    const current = createContainer();
    const stale = createContainer();
    const context = { gatewayScope: {}, sessionIdentity: "same-session", cardLifetime: {} };
    renderTranscriptCard(current, context);
    renderTranscriptCard(stale, context);
    const replacement = { ...context, cardLifetime: {} };
    renderTranscriptCard(current, replacement, { ...progressCard, revision: 1 });
    current.querySelector("summary")!.click();
    expect(current.querySelector("details")!.open).toBe(false);
    stale.querySelector("summary")!.click();
    stale.querySelector("summary")!.click();
    expect(stale.querySelector("details")!.open).toBe(true);
    render(nothing, current);
    renderTranscriptCard(current, replacement, { ...progressCard, revision: 1 });
    expect(current.querySelector("details")!.open).toBe(false);
  });

  it("header takeover clears pending transcript gestures before fresh history can collapse it", async () => {
    const container = createContainer();
    renderTranscriptCard(container, { readingHistory: true });
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
  it("preserves another pane's newer manual reopen after stale automatic collapse and remount", async () => {
    const first = createContainer();
    const second = createContainer();
    const context = { gatewayScope: {}, cardLifetime: {}, readingHistory: true };
    renderTranscriptCard(first, context);
    renderTranscriptCard(second, context);
    const transcript = observeTranscript(first, transcriptCleanups);
    await Promise.resolve();
    second.querySelector("summary")!.click();
    second.querySelector("summary")!.click();
    expect(second.querySelector("details")!.open).toBe(true);
    transcript.wheel(200);
    vi.advanceTimersByTime(201);
    transcript.wheel(200);
    vi.advanceTimersByTime(300);
    expect(first.querySelector("details")!.open).toBe(false);
    render(nothing, second);
    renderTranscriptCard(second, context);
    expect(second.querySelector("details")!.open).toBe(true);
  });

  it.each([
    { first: progressCard.sessionKey, next: "agent:main:next" },
    { first: "global", next: "agent:main:global" },
  ])(
    "remembers each authoritative card across Gateway/session switching and remounting: $first",
    ({ first: session, next }) => {
      const container = createContainer();
      const gatewayA = {};
      const gatewayB = {};
      const firstLifetime = {};
      const nextLifetime = {};
      const otherGatewayLifetime = {};
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
            {
              gatewayScope,
              sessionIdentity: JSON.stringify(["main", sessionKey]),
              cardLifetime:
                gatewayScope === gatewayB
                  ? otherGatewayLifetime
                  : sessionKey === session
                    ? firstLifetime
                    : nextLifetime,
            },
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
