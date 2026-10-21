import "../../styles/approval.css";
import "../../styles/chat/question-card.css";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createSignal, onCleanup, For, Show } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { canUseQuestionPrompts, requestQuestionGateway } from "../../app/question-prompt-client.ts";
import {
  cancelQuestionPrompt,
  createQuestionPromptState,
  disposeQuestionPromptState,
  handleQuestionPromptEvent,
  isQuestionNotFoundError,
  listQuestionPrompts,
  setQuestionPromptClient,
  submitQuestionPrompt,
  type QuestionPrompt,
} from "../../app/question-prompt.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { createDocumentTitle } from "../../lib/reactive/document-title.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { createPendingFocus } from "../../lib/reactive/pending-focus.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { ChatQuestionCard } from "../chat/components/chat-question-card-view.tsx";
import { createGatewayQuestionPanelProps } from "../chat/components/chat-question-card.ts";
import { terminalAnswer } from "../chat/components/chat-question-summary.tsx";

type QuestionPageRequestError = "connection" | "load" | "unavailable" | null;

type QuestionPageProps = { questionId: string };

const questionIdHandlers = new WeakMap<HTMLElement, () => void>();

function createQuestionPage(
  context: ApplicationContext,
  props: QuestionPageProps,
  host: SolidBridgeElement<QuestionPageProps>,
) {
  // The bridge owns this live value; callbacks must see changes before the next render.
  const questionId = () => host.questionId;
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [requestError, setRequestError] = createSignal<QuestionPageRequestError>(null, {
    ownedWrite: true,
  });
  let clientOwner: GatewayBrowserClient | null = null;
  let operationGeneration = 0;
  let questionPanel: HTMLElement | undefined;
  let heading: HTMLHeadingElement | undefined;
  let questionPanelHadFocus = false;
  const rememberPanelFocus = () => {
    questionPanelHadFocus =
      questionPanel?.contains(document.activeElement) ||
      (questionPanelHadFocus && document.activeElement === document.body);
  };
  let publishQuestions = () => {};
  const questionState = createQuestionPromptState(() => {
    rememberPanelFocus();
    publishQuestions();
  });
  const questions = projectSource(questionState, {
    read: listQuestionPrompts,
    subscribe: (_state, notify) => {
      publishQuestions = notify;
      return () => {
        publishQuestions = () => {};
      };
    },
    equality: "revision",
  });
  const prompt = () => questions.read().find((candidate) => candidate.id === props.questionId);
  // Gateway receipts retire question operations and rebind the prompt client synchronously before reconnect.
  const stopGateway = context.gateway.subscribe(applyGatewaySnapshot);
  const stopGatewayEvents = context.gateway.subscribeEvents((event) => {
    if (isRecord(event.payload) && event.payload.id === questionId()) {
      handleQuestionPromptEvent(questionState, event);
    }
  });
  applyGatewaySnapshot(context.gateway.snapshot);
  onCleanup(() => {
    questionIdHandlers.delete(host);
    stopGateway();
    stopGatewayEvents();
    operationGeneration += 1;
    clientOwner = null;
    disposeQuestionPromptState(questionState);
  });
  // Native ID receipts retire operations before another question can dispatch.
  questionIdHandlers.set(host, () => {
    const id = questionId();
    const generation = ++operationGeneration;
    rememberPanelFocus();
    // Keep successive native writes in one turn on a single lookup.
    queueMicrotask(() => {
      if (operationGeneration !== generation) {
        return;
      }
      setRequestError(id ? null : "unavailable");
      setLoading(Boolean(id));
      if (id && clientOwner) {
        void loadQuestion(clientOwner, id);
      }
    });
  });
  const title = () => `${pageTitle(prompt())} — ${t("approvalPage.brandName")}`;
  createDocumentTitle(title);
  createPendingFocus(title, {
    requested: () => questionPanelHadFocus && !questionPanel?.isConnected,
    focus: () => heading?.focus({ preventScroll: true }),
  });

  function applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot): void {
    rememberPanelFocus();
    const nextClient = snapshot.phase === "connected" ? snapshot.client : null;
    if (clientOwner === nextClient) {
      if (
        !nextClient &&
        (snapshot.lastError ||
          snapshot.phase === "offline" ||
          snapshot.phase === "reload-required" ||
          snapshot.phase === "stopped")
      ) {
        setLoading(false);
        setRequestError("connection");
      }
      return;
    }
    operationGeneration += 1;
    clientOwner = nextClient;
    setQuestionPromptClient(questionState, canUseQuestionPrompts(snapshot) ? nextClient : null);
    if (!nextClient) {
      if (listQuestionPrompts(questionState).some((candidate) => candidate.id === questionId())) {
        setLoading(false);
        setRequestError("connection");
      }
      return;
    }
    if (!questionId()) {
      setLoading(false);
      setRequestError("unavailable");
      return;
    }
    void loadQuestion(nextClient);
  }

  async function loadQuestion(client: GatewayBrowserClient, id = questionId()): Promise<void> {
    if (!canUseQuestionPrompts(context.gateway.snapshot)) {
      setLoading(false);
      setRequestError("unavailable");
      return;
    }
    const generation = ++operationGeneration;
    setLoading(true);
    setRequestError(null);
    rememberPanelFocus();
    try {
      const result = await requestQuestionGateway(client, "question.get", { id });
      if (clientOwner !== client || operationGeneration !== generation || questionId() !== id) {
        return;
      }
      if (result.question.id !== id) {
        setRequestError("unavailable");
        return;
      }
      const record = result.question;
      if (
        !handleQuestionPromptEvent(questionState, {
          event: "question.requested",
          payload: { ...record, status: "pending" },
        })
      ) {
        setRequestError("unavailable");
        return;
      }
      if (record.status === "answered") {
        const accepted = handleQuestionPromptEvent(questionState, {
          event: "question.resolved",
          payload: { id, status: "answered", answers: record.answers },
        });
        if (!accepted) {
          setRequestError("unavailable");
        }
      } else if (record.status === "cancelled" || record.status === "expired") {
        handleQuestionPromptEvent(questionState, {
          event: "question.resolved",
          payload: { id, status: record.status },
        });
      }
    } catch (error) {
      if (clientOwner === client && operationGeneration === generation) {
        setRequestError(isQuestionNotFoundError(error) ? "unavailable" : "load");
      }
    } finally {
      if (clientOwner === client && operationGeneration === generation) {
        setLoading(false);
        rememberPanelFocus();
      }
    }
  }

  function questionStatusLabel(value: QuestionPrompt): string {
    return t(
      {
        answered: "chat.questions.answered",
        cancelled: "chat.questions.skipped",
        expired: "chat.questions.expired",
        pending: "chat.questions.unavailable",
        unavailable: "chat.questions.unavailable",
      }[value.status],
    );
  }

  function pageTitle(value: QuestionPrompt | undefined): string {
    if (loading()) {
      return t("common.loading");
    }
    const error = requestError();
    if (error) {
      return t(
        error === "connection"
          ? "chat.questions.disconnected"
          : error === "load"
            ? "chat.questions.loadFailed"
            : "chat.questions.unavailable",
      );
    }
    return value && value.status !== "pending"
      ? questionStatusLabel(value)
      : t("chat.questions.eyebrow");
  }

  return {
    loading,
    requestError,
    prompt,
    pageTitle,
    questionStatusLabel,
    questionState,
    refreshQuestions: () => questionState.onChange(),
    setPanel: (element: HTMLElement) => {
      questionPanel = element;
    },
    setHeading: (element: HTMLHeadingElement) => {
      heading = element;
    },
    retry: () => {
      if (clientOwner) {
        void loadQuestion(clientOwner);
      }
    },
  };
}

function QuestionSummary(props: { prompt: QuestionPrompt }) {
  return (
    <div class="chat-question-summary" aria-label={t("chat.questions.summaryLabel")}>
      <For each={props.prompt.questions} keyed={(question) => question.questionId}>
        {(question) => (
          <div class="chat-question-summary__item">
            <div class="chat-question-summary__prompt">{question().question}</div>
            <div class="chat-question-summary__line">
              <strong>{question().header}:</strong>
              <span>{terminalAnswer(props.prompt, question())}</span>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}

function QuestionPageContent(
  props: QuestionPageProps,
  host: SolidBridgeElement<QuestionPageProps>,
) {
  const context = useApplication();
  const page = createQuestionPage(context, props, host);
  const panelProps = () => {
    const prompt = page.prompt();
    return prompt
      ? createGatewayQuestionPanelProps(prompt, {
          onChange: page.refreshQuestions,
          onSubmit: (answers) => submitQuestionPrompt(page.questionState, prompt.id, answers),
          onSkip: () => cancelQuestionPrompt(page.questionState, prompt.id),
        })
      : undefined;
  };
  return (
    <main
      class="approval-page question-page"
      aria-labelledby="question-page-title"
      aria-busy={page.loading() ? "true" : "false"}
      data-state={page.prompt()?.status ?? page.requestError() ?? "loading"}
    >
      <div class="approval-page__card approval-page__card--severity-info">
        <div class="approval-page__content">
          <Show
            when={
              page.loading() ||
              page.requestError() ||
              !page.prompt() ||
              page.prompt()?.status === "pending"
            }
          >
            <h1 ref={page.setHeading} id="question-page-title" class="sr-only" tabindex="-1">
              {page.pageTitle(page.prompt())}
            </h1>
          </Show>
          <Show
            when={!page.loading() && !page.requestError()}
            fallback={
              <div class="approval-page__state" role="status">
                {page.pageTitle(page.prompt())}
                <Show when={!page.loading() && page.requestError() === "load"}>
                  <button type="button" class="btn" onClick={() => page.retry()}>
                    {t("common.retry")}
                  </button>
                </Show>
              </div>
            }
          >
            <Show when={page.prompt()}>
              {(prompt) => (
                <Show
                  when={page.prompt()?.status === "pending"}
                  fallback={
                    <div
                      class="approval-page__state"
                      data-question-status={prompt().status}
                      role="status"
                    >
                      <h1 ref={page.setHeading} id="question-page-title" tabindex="-1">
                        {page.questionStatusLabel(prompt())}
                      </h1>
                      <QuestionSummary prompt={prompt()} />
                    </div>
                  }
                >
                  <ChatQuestionCard ref={page.setPanel} props={panelProps()} />
                </Show>
              )}
            </Show>
          </Show>
        </div>
      </div>
    </main>
  );
}

defineSolidBridge<QuestionPageProps>(
  "openclaw-question-page",
  (props, host) => QuestionPageContent(props, host),
  {
    properties: { questionId: { default: "", attribute: "question-id" } },
    propertyChanged: (host) => questionIdHandlers.get(host)?.(),
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-question-page": SolidBridgeElement<QuestionPageProps>;
  }
}
