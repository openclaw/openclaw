import type { Component } from "@mariozechner/pi-tui";
import { createSearchableSelectList } from "./components/selectors.js";
import type { ChatLog } from "./components/chat-log.js";
import type { GatewayChatClient } from "./gateway-chat.js";
import type {
  PlanInputQuestion,
  PlanInputRequestedEvent,
  PlanInputResolvedEvent,
} from "./tui-types.js";

type PendingPlanInput = {
  prompt: PlanInputRequestedEvent;
  currentIndex: number;
  answers: Record<
    string,
    {
      answer: string;
      source: "option" | "other";
      optionIndex?: number;
    }
  >;
  awaitingFreeform: boolean;
};

export function createPlanInputController(params: {
  client: GatewayChatClient;
  chatLog: ChatLog;
  tui: { requestRender: () => void };
  openOverlay: (component: Component) => void;
  closeOverlay: () => void;
  setActivityStatus: (text: string) => void;
}) {
  let pending: PendingPlanInput | null = null;
  let localResolutionId: string | null = null;

  const currentQuestion = (): PlanInputQuestion | null => {
    if (!pending) {
      return null;
    }
    return pending.prompt.questions[pending.currentIndex] ?? null;
  };

  const finishResolution = async (
    status: "answered" | "cancelled",
    answers?: PendingPlanInput["answers"],
  ) => {
    if (!pending) {
      return;
    }
    const promptId = pending.prompt.id;
    localResolutionId = promptId;
    const currentPending = pending;
    pending = null;
    params.closeOverlay();
    params.setActivityStatus("waiting");
    params.tui.requestRender();
    await params.client.resolvePlanInput({
      id: promptId,
      status,
      answers,
    });
    if (status === "answered") {
      params.chatLog.addSystem("plan input answered");
    } else {
      params.chatLog.addSystem("plan input cancelled");
    }
    params.tui.requestRender();
    if (currentPending.prompt.id === localResolutionId) {
      localResolutionId = null;
    }
  };

  const promptForCurrentQuestion = () => {
    const question = currentQuestion();
    if (!pending || !question) {
      return;
    }
    const selector = createSearchableSelectList(
      [
        ...question.options.map((option, index) => ({
          value: String(index),
          label: option.label,
          description: option.description,
        })),
        {
          value: "__other__",
          label: "Other...",
          description: "Type a freeform answer in the editor",
        },
      ],
      9,
    );
    selector.onSelect = (item) => {
      void (async () => {
        if (!pending) {
          return;
        }
        if (item.value === "__other__") {
          pending.awaitingFreeform = true;
          params.closeOverlay();
          params.chatLog.addSystem(
            `[${question.header}] ${question.question} (type your answer in the editor)`,
          );
          params.setActivityStatus("plan input");
          params.tui.requestRender();
          return;
        }
        const optionIndex = Number.parseInt(item.value, 10);
        const option = question.options[optionIndex];
        if (!option) {
          return;
        }
        pending.answers[question.id] = {
          answer: option.label,
          source: "option",
          optionIndex,
        };
        pending.currentIndex += 1;
        if (pending.currentIndex >= pending.prompt.questions.length) {
          await finishResolution("answered", pending.answers);
          return;
        }
        promptForCurrentQuestion();
      })();
    };
    selector.onCancel = () => {
      void finishResolution("cancelled");
    };
    params.openOverlay(selector);
    params.setActivityStatus("plan input");
    params.tui.requestRender();
  };

  return {
    hasPendingFreeformAnswer() {
      return Boolean(pending?.awaitingFreeform);
    },
    async consumeFreeformAnswer(text: string) {
      if (!pending?.awaitingFreeform) {
        return false;
      }
      const question = currentQuestion();
      if (!question) {
        return false;
      }
      pending.awaitingFreeform = false;
      pending.answers[question.id] = {
        answer: text.trim(),
        source: "other",
      };
      pending.currentIndex += 1;
      if (pending.currentIndex >= pending.prompt.questions.length) {
        await finishResolution("answered", pending.answers);
      } else {
        promptForCurrentQuestion();
      }
      return true;
    },
    handleRequested(prompt: PlanInputRequestedEvent) {
      pending = {
        prompt,
        currentIndex: 0,
        answers: {},
        awaitingFreeform: false,
      };
      params.chatLog.addSystem(
        `plan input requested (${prompt.questions.length} question${prompt.questions.length === 1 ? "" : "s"})`,
      );
      promptForCurrentQuestion();
    },
    handleResolved(event: PlanInputResolvedEvent) {
      if (!pending || pending.prompt.id !== event.id) {
        return;
      }
      params.closeOverlay();
      pending = null;
      params.setActivityStatus("waiting");
      if (localResolutionId === event.id) {
        localResolutionId = null;
        return;
      }
      if (event.status === "expired") {
        params.chatLog.addSystem("plan input expired");
      }
      params.tui.requestRender();
    },
  };
}
