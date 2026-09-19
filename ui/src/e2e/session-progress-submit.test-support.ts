import type { Page } from "playwright";
import type { ControlUiMockGatewayScenario } from "../test-helpers/control-ui-e2e.ts";

export function progressSubmitScenario(activeRun = false) {
  const sessionKey = "agent:main:main";
  return {
    sessionKey,
    agentModel: "example/demo-model",
    models: [{ id: "demo-model", name: "Demo model", provider: "example", contextWindow: 128000 }],
    sessionInfo: {
      key: sessionKey,
      hasActiveRun: activeRun,
      activeRunIds: activeRun ? ["existing-run"] : [],
      status: activeRun ? "running" : "done",
    },
    ...(activeRun
      ? { inFlightRun: { runId: "existing-run", text: "Checking the workspace." } }
      : {}),
    historyMessages: Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: [{ type: "text", text: `Review note ${index + 1}. The workspace is ready.` }],
      timestamp: index + 1,
    })),
    featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
    deferredMethods: ["chat.send"],
    methodResponses: {
      "progressCard.get": {
        card: {
          sessionKey,
          revision: 1,
          updatedAt: 1,
          markdown: "Reviewing the synthetic workspace.",
          steps: [
            { step: "Inspect the workspace", status: "completed" },
            { step: "Verify the progress card", status: "in_progress" },
            { step: "Summarize the result", status: "pending" },
          ],
        },
      },
    },
  } satisfies ControlUiMockGatewayScenario;
}

export function observeProgressSubmit(page: Page) {
  return page
    .locator(".agent-chat__composer-combobox openclaw-composer-editor")
    .evaluateHandle((textarea) => {
      const pane = textarea.closest("openclaw-chat-pane")!;
      const card = pane.querySelector<HTMLDetailsElement>(".session-progress-card--composer")!;
      const composer = pane.querySelector<HTMLElement>(".agent-chat__input")!;
      const thread = pane.querySelector<HTMLElement>(".chat-thread")!;
      const lastMessage = [...thread.querySelectorAll(".chat-bubble")].at(-1);
      let startedAt = 0;
      let finished = false;
      const sample = (source: string) => {
        const current = pane.querySelector<HTMLDetailsElement>(".session-progress-card--composer");
        const bounds = current?.getBoundingClientRect();
        const input = composer.getBoundingClientRect();
        return {
          t: performance.now() - startedAt,
          source,
          height: bounds?.height ?? 0,
          top: bounds?.top ?? 0,
          open: current?.open ?? null,
          reveal: current?.dataset.reveal ?? null,
          retained: current === card && card.isConnected,
          composerHeight: input.height,
          composerTop: input.top,
          stackGap: input.top - (bounds?.top ?? 0),
          scrollTop: thread.scrollTop,
          lastMessageTop: lastMessage?.isConnected ? lastMessage.getBoundingClientRect().top : null,
          currentLastMessageTop:
            [...thread.querySelectorAll(".chat-bubble")].at(-1)?.getBoundingClientRect().top ??
            null,
          queueRows: pane.querySelectorAll(".chat-queue__item").length,
        };
      };
      const samples: ReturnType<typeof sample>[] = [];
      const done = new Promise<typeof samples>((resolve) => {
        textarea.addEventListener(
          "keydown",
          function start(event) {
            if ((event as KeyboardEvent).key !== "Enter") {
              return;
            }
            textarea.removeEventListener("keydown", start, true);
            startedAt = performance.now();
            samples.push(sample("keydown"));
            const mutations = new MutationObserver(() => samples.push(sample("mutation")));
            mutations.observe(pane.querySelector(".agent-chat__composer-shell")!, {
              attributes: true,
              childList: true,
              subtree: true,
            });
            const resize = new ResizeObserver(() => samples.push(sample("resize")));
            resize.observe(card);
            resize.observe(composer);
            const frame = () => {
              samples.push(sample("frame"));
              if (!finished || performance.now() - startedAt < 1000) {
                requestAnimationFrame(frame);
              } else {
                mutations.disconnect();
                resize.disconnect();
                resolve(samples);
              }
            };
            requestAnimationFrame(frame);
          },
          { capture: true },
        );
      });
      return {
        finish() {
          finished = true;
          return done;
        },
      };
    });
}
