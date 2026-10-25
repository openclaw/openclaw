import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, createSignal, Errored, For, Loading, onSettled, Show } from "solid-js";
import "../../styles/approval.css";
import "../../styles/chat/question-card.css";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
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
import { registerApprovalsEnglish } from "../../i18n/locales/en-approvals.ts";
import { registerChatQuestionsEnglish } from "../../i18n/locales/en-chat-questions.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { createDocumentTitle } from "../../lib/reactive/document-title.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { createPendingFocus } from "../../lib/reactive/pending-focus.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { ChatQuestionCard } from "../chat/components/chat-question-card-view.tsx";
import { createGatewayQuestionPanelProps } from "../chat/components/chat-question-card.ts";
import { terminalAnswer } from "../chat/components/chat-question-summary.tsx";

registerEnglishCatalog(registerChatQuestionsEnglish);

registerEnglishCatalog(registerApprovalsEnglish);

type QuestionPageRequestError = "connection" | "load" | "unavailable" | null;

class QuestionReadError extends Error {
  readonly kind: Exclude<QuestionPageRequestError, null>;
  constructor(kind: Exclude<QuestionPageRequestError, null>) {
    super(kind);
    this.kind = kind;
  }
}

type QuestionPageProps = { questionId: string };

const questionIdHandlers = new WeakMap<HTMLElement, () => void>();

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
  // The bridge owns this live value; callbacks must see changes before the next render.
  const questionId = () => host.questionId;
  let completion = Promise.withResolvers<QuestionPageRequestError>();
  const [request, setRequest] = createSignal({ completion: completion.promise });
  function beginRead() {
    // Release presentation when the synchronous owner retires a lookup.
    completion.resolve(null);
    completion = Promise.withResolvers<QuestionPageRequestError>();
    setRequest({ completion: completion.promise });
    return completion.resolve;
  }
  function failRead(error: Exclude<QuestionPageRequestError, null>) {
    beginRead()(error);
  }
  let clientOwner: GatewayBrowserClient | null = null;
  let operationGeneration = 0;
  let questionPanel: HTMLElement | undefined;
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
  const readPrompt = () => questions.read().find((candidate) => candidate.id === props.questionId);
  onSettled(() => {
    // Native receipts retire operations before another question can dispatch.
    questionIdHandlers.set(host, () => {
      const id = questionId();
      const generation = ++operationGeneration;
      rememberPanelFocus();
      // Keep successive native writes in one turn on a single lookup.
      queueMicrotask(() => {
        if (operationGeneration !== generation) {
          return;
        }
        if (!id) {
          failRead("unavailable");
        } else if (clientOwner) {
          void loadQuestion(clientOwner, id);
        } else {
          beginRead();
        }
      });
    });
    const stopGateway = context.gateway.subscribe(applyGatewaySnapshot);
    const stopGatewayEvents = context.gateway.subscribeEvents((event) => {
      if (isRecord(event.payload) && event.payload.id === questionId()) {
        handleQuestionPromptEvent(questionState, event);
      }
    });
    applyGatewaySnapshot(context.gateway.snapshot);
    return () => {
      questionIdHandlers.delete(host);
      stopGateway();
      stopGatewayEvents();
      operationGeneration += 1;
      clientOwner = null;
      completion.resolve(null);
      disposeQuestionPromptState(questionState);
    };
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
        failRead("connection");
      }
      return;
    }
    operationGeneration += 1;
    clientOwner = nextClient;
    setQuestionPromptClient(questionState, canUseQuestionPrompts(snapshot) ? nextClient : null);
    if (!nextClient) {
      if (listQuestionPrompts(questionState).some((candidate) => candidate.id === questionId())) {
        failRead("connection");
      }
      return;
    }
    if (!questionId()) {
      failRead("unavailable");
      return;
    }
    void loadQuestion(nextClient);
  }

  async function loadQuestion(client: GatewayBrowserClient, id = questionId()): Promise<void> {
    if (!canUseQuestionPrompts(context.gateway.snapshot)) {
      failRead("unavailable");
      return;
    }
    const generation = ++operationGeneration;
    const complete = beginRead();
    let requestError: QuestionPageRequestError = null;
    rememberPanelFocus();
    try {
      const result = await requestQuestionGateway(client, "question.get", { id });
      if (clientOwner !== client || operationGeneration !== generation || questionId() !== id) {
        return;
      }
      if (result.question.id !== id) {
        requestError = "unavailable";
        return;
      }
      const record = result.question;
      if (
        !handleQuestionPromptEvent(questionState, {
          event: "question.requested",
          payload: { ...record, status: "pending" },
        })
      ) {
        requestError = "unavailable";
        return;
      }
      if (record.status === "answered") {
        const accepted = handleQuestionPromptEvent(questionState, {
          event: "question.resolved",
          payload: { id, status: "answered", answers: record.answers },
        });
        if (!accepted) {
          requestError = "unavailable";
        }
      } else if (record.status === "cancelled" || record.status === "expired") {
        handleQuestionPromptEvent(questionState, {
          event: "question.resolved",
          payload: { id, status: record.status },
        });
      }
    } catch (error) {
      if (clientOwner === client && operationGeneration === generation) {
        requestError = isQuestionNotFoundError(error) ? "unavailable" : "load";
      }
    } finally {
      if (clientOwner === client && operationGeneration === generation) {
        complete(requestError);
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

  function pageTitle(
    value: QuestionPrompt | undefined,
    error: QuestionPageRequestError | "loading",
  ): string {
    if (error === "loading") {
      return t("common.loading");
    }
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

  const refreshQuestions = () => questionState.onChange();
  const setPanel = (element: HTMLElement) => {
    questionPanel = element;
  };
  const needsFocus = () => questionPanelHadFocus && !questionPanel?.isConnected;
  const retry = () => {
    if (clientOwner) {
      void loadQuestion(clientOwner);
    }
  };
  const panelProps = () => {
    const prompt = readPrompt();
    return prompt
      ? createGatewayQuestionPanelProps(prompt, {
          onChange: refreshQuestions,
          onSubmit: (answers) => submitQuestionPrompt(questionState, prompt.id, answers),
          onSkip: () => cancelQuestionPrompt(questionState, prompt.id),
        })
      : undefined;
  };
  function Frame(frameProps: { state: QuestionPageRequestError | "loading"; retry?: () => void }) {
    let heading: HTMLHeadingElement | undefined;
    const title = () => pageTitle(readPrompt(), frameProps.state);
    createDocumentTitle(() => `${title()} — ${t("approvalPage.brandName")}`);
    createPendingFocus(title, {
      requested: needsFocus,
      focus: () => heading?.focus({ preventScroll: true }),
    });
    return (
      <main
        class="approval-page question-page"
        aria-labelledby="question-page-title"
        aria-busy={frameProps.state === "loading" ? "true" : "false"}
        data-state={readPrompt()?.status ?? frameProps.state ?? "loading"}
      >
        <div class="approval-page__card approval-page__card--severity-info">
          <div class="approval-page__content">
            <Show when={frameProps.state || !readPrompt() || readPrompt()?.status === "pending"}>
              <h1
                ref={(element) => {
                  heading = element;
                }}
                id="question-page-title"
                class="sr-only"
                tabindex="-1"
              >
                {title()}
              </h1>
            </Show>
            <Show
              when={!frameProps.state}
              fallback={
                <div class="approval-page__state" role="status">
                  {title()}
                  <Show when={frameProps.state === "load"}>
                    <button type="button" class="btn" onClick={() => (frameProps.retry ?? retry)()}>
                      {t("common.retry")}
                    </button>
                  </Show>
                </div>
              }
            >
              <Show when={readPrompt()}>
                {(prompt) => (
                  <Show
                    when={readPrompt()?.status === "pending"}
                    fallback={
                      <div
                        class="approval-page__state"
                        data-question-status={prompt().status}
                        role="status"
                      >
                        <h1
                          ref={(element) => {
                            heading = element;
                          }}
                          id="question-page-title"
                          tabindex="-1"
                        >
                          {questionStatusLabel(prompt())}
                        </h1>
                        <QuestionSummary prompt={prompt()} />
                      </div>
                    }
                  >
                    <ChatQuestionCard ref={setPanel} props={panelProps()} />
                  </Show>
                )}
              </Show>
            </Show>
          </div>
        </div>
      </main>
    );
  }
  function ReadyFrame() {
    const ready = createMemo(() =>
      request().completion.then((error) => {
        if (error) {
          throw new QuestionReadError(error);
        }
        return true;
      }),
    );
    return (
      <Show when={ready()}>
        <Frame state={null} />
      </Show>
    );
  }
  return (
    <Loading on={request()} fallback={<Frame state="loading" />}>
      <Errored
        fallback={(error, reset) => {
          const state = () => {
            const cause = error();
            return cause instanceof QuestionReadError ? cause.kind : "load";
          };
          return (
            <Frame
              state={state()}
              retry={() => {
                retry();
                reset();
              }}
            />
          );
        }}
      >
        <ReadyFrame />
      </Errored>
    </Loading>
  );
}

export const QuestionPage = defineSolidBridge<QuestionPageProps>(
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
