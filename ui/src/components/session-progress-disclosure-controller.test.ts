/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
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

const { createContainer, render, transcriptCleanups } = progressCardFixture();

function renderTranscriptCard(
  container: HTMLElement,
  context: ComposerProgressDisclosureContext,
  card = progressCard,
  sessionStatus: "running" | "done" = "running",
  collapsed = false,
) {
  return render(
    {
      card,
      sessionStatus,
      startedAt: RUN_STARTED_MS,
      endedAt: sessionStatus === "done" ? RUN_ENDED_MS : undefined,
      hasActiveRun: sessionStatus === "running",
      collapseComposerByDefault: collapsed,
      composerDisclosureContext: context,
      transcript: true,
    },
    container,
  );
}

describe("elastic progress disclosure controller", () => {
  it("parks disclosure gestures and restores the retained choice on reveal", () => {
    const container = createContainer();
    const view = renderTranscriptCard(container, { cardLifetime: {} });
    const summary = container.querySelector("summary")!;
    const wheel = () => {
      const event = new WheelEvent("wheel", { deltaY: -48, bubbles: true, cancelable: true });
      summary.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(wheel()).toBe(true);
    const body = cardPart<HTMLElement>(container, "body")!;
    const chosenHeight = body.style.height;
    view.setPresented(false);
    expect(wheel()).toBe(false);
    view.setPresented(true);
    expect(body.style.height).toBe(chosenHeight);
    expect(wheel()).toBe(true);
  });

  it.each([
    { mobile: false, partial: false, retained: true },
    { mobile: true, partial: false, retained: true },
    { mobile: false, partial: true, retained: true },
    { mobile: false, partial: false, retained: false },
  ])(
    "retains manual disclosure only for its card lifetime (mobile=$mobile, partial=$partial, retained=$retained)",
    ({ mobile, partial, retained }) => {
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
          {
            gatewayScope,
            sessionIdentity: "same-session",
            cardLifetime: retained ? lifetime : undefined,
          },
          {
            ...progressCard,
            revision,
            steps:
              final && !partial
                ? progressCard.steps?.map(({ step }) => ({ step, status: "completed" as const }))
                : progressCard.steps,
          },
          final ? "done" : "running",
          partial,
        );
      const initialOpen = !mobile && !partial;
      const manualOpen = mobile || partial;
      const body = () => cardPart<HTMLElement>(container, "body")!;
      const expectChoice = (open: boolean, height = "") => {
        expect(container.querySelector("details")!.open).toBe(open);
        expect(body().style.height).toBe(height);
      };
      show();
      expectChoice(initialOpen);
      const summary = container.querySelector("summary")!;
      if (partial) {
        summary.dispatchEvent(
          new WheelEvent("wheel", { deltaY: -48, bubbles: true, cancelable: true }),
        );
      } else {
        summary.click();
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
          render(null, container);
          remounted = true;
        }
        show(cardLifetime, revision, final);
        expectChoice(!retained && remounted ? initialOpen : manualOpen, partial ? "48px" : "");
      }
      const replacement = {};
      show(replacement, 1);
      expectChoice(initialOpen);
      expect(body().style.minHeight).toBe("");
      render(null, container);
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
  ] as const)(
    "retains a %s collapse through revisions, completion, and remount",
    async (choice) => {
      const container = createContainer();
      const context = { gatewayScope: {}, cardLifetime: {}, readingHistory: true };
      renderTranscriptCard(container, context);
      let card = container.querySelector("details")!;
      const summary = card.querySelector("summary")!;
      if (choice !== "header") {
        const transcript = observeTranscript(container, transcriptCleanups);
        await Promise.resolve();
        if (choice !== "history") {
          transcript.thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -200, bubbles: true }));
          advance(301);
          expect(card.open).toBe(true);
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
            renderTranscriptCard(container, context);
            await Promise.resolve();
          }
          transcript.scroll(200);
          if (choice !== "delayed history") {
            advance(301);
            expect(card.open).toBe(true);
            transcript.wheel(200);
            advance(301);
            expect(card.open).toBe(true);
          }
        } else {
          transcript.wheel(200);
        }
        advance(201);
        transcript.wheel(200);
        advance(301);
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
      render(null, container);
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
        renderTranscriptCard(
          container,
          { onManipulate },
          progressCard,
          final ? "done" : "running",
          collapsed,
        );
      show();
      const card = container.querySelector("details")!;
      const body = cardPart<HTMLElement>(card, "body")!;
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
    render(null, current);
    renderTranscriptCard(current, replacement, { ...progressCard, revision: 1 });
    expect(current.querySelector("details")!.open).toBe(false);
  });

  it.each(["hidden", "header"])(
    "%s takeover requires fresh transcript gestures before collapse",
    async (takeover) => {
      const container = createContainer();
      const cardLifetime = takeover === "hidden" ? {} : undefined;
      const show = (presented: boolean) =>
        renderTranscriptCard(container, { cardLifetime, readingHistory: true, presented });
      show(true);
      const transcript = observeTranscript(container, transcriptCleanups);
      await Promise.resolve();
      const card = container.querySelector("details")!;
      const body = cardPart<HTMLElement>(card, "body")!;
      transcript.wheel(200);
      advance(201);
      transcript.wheel(200);

      if (takeover === "hidden") {
        show(false);
        await Promise.resolve();
      } else {
        card
          .querySelector("summary")!
          .dispatchEvent(new WheelEvent("wheel", { deltaY: -48, bubbles: true, cancelable: true }));
      }
      advance(1000);
      expect(card.open).toBe(true);
      expect(body.style.height).toBe(takeover === "header" ? "48px" : "");
      if (takeover === "hidden") {
        transcript.wheel(200);
        advance(301);
        transcript.wheel(200);
        advance(301);
        expect(card.open).toBe(true);
        show(true);
        await Promise.resolve();
        expect(container.querySelector("details")).toBe(card);
      }
      transcript.wheel(200);
      advance(301);
      expect(card.open).toBe(true);
      transcript.wheel(200);
      advance(301);
      expect(card.open).toBe(false);
      expect(body.style.height).toBe("");
    },
  );
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
    advance(201);
    transcript.wheel(200);
    advance(300);
    expect(first.querySelector("details")!.open).toBe(false);
    render(null, second);
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
          {
            card: {
              ...progressCard,
              sessionKey: sessionKey === "global" ? "agent:main:global" : sessionKey,
            },
            hasActiveRun: true,
            collapseComposerByDefault: false,
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
          },
          container,
        );
      renderCard(gatewayA);
      const first = container.querySelector("details")!;
      first.querySelector("summary")!.click();
      first.open = true;
      first.querySelector("summary")!.click();
      renderCard(gatewayA);
      expect(first.open).toBe(false);
      renderCard(gatewayA, next);
      expect(container.querySelector("details")!.open).toBe(true);
      renderCard(gatewayA);
      expect(container.querySelector("details")!.open).toBe(false);
      renderCard(gatewayB);
      expect(container.querySelector("details")!.open).toBe(true);
      renderCard(gatewayA);
      expect(container.querySelector("details")!.open).toBe(false);
      render(null, container);
      renderCard(gatewayA);
      expect(container.querySelector("details")!.open).toBe(false);
    },
  );
});
