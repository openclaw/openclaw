import "../../styles/approval.css";
import "../../styles/chat/question-card.css";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createEffect, createSignal, onCleanup, For, Show, untrack } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { requestQuestionGateway } from "../../app/question-prompt-client.ts";
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
import { t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
import { ChatQuestionCard } from "../chat/components/chat-question-card-view.tsx";
import { createGatewayQuestionPanelProps } from "../chat/components/chat-question-card.ts";

type QuestionPageRequestError = "connection" | "load" | "unavailable" | null;

type QuestionPageProps = { questionId: string };

class QuestionPageController {
  loading = true;
  requestError: QuestionPageRequestError = null;
  readonly questionState = createQuestionPromptState(() => this.notify());

  constructor(
    readonly context: ApplicationContext,
    private readonly props: QuestionPageProps,
    private readonly host: HTMLElement,
    private readonly publish: () => void,
  ) {}
  get questionId() {
    return untrack(() => this.props.questionId);
  }
  get prompt() {
    return listQuestionPrompts(this.questionState).find(
      (candidate) => candidate.id === this.questionId,
    );
  }
  private notify() {
    const panel = this.host.querySelector("openclaw-chat-question-card");
    this.questionPanelHadFocus =
      panel !== null &&
      (panel.contains(document.activeElement) ||
        (this.questionPanelHadFocus && document.activeElement === document.body));
    this.publish();
  }
  private client: GatewayBrowserClient | null = null;
  private boundQuestionId: string | undefined;
  private operationGeneration = 0;
  private stopGateway: (() => void) | undefined;
  private stopGatewayEvents: (() => void) | undefined;
  private previousDocumentTitle: string | undefined;
  private activeDocumentTitle: string | undefined;
  private questionPanelHadFocus = false;

  connect(): void {
    this.previousDocumentTitle = document.title;
    this.boundQuestionId = this.questionId;
    this.stopGateway = this.context.gateway.subscribe((snapshot) =>
      this.applyGatewaySnapshot(snapshot),
    );
    this.stopGatewayEvents = this.context.gateway.subscribeEvents((event) => {
      if (isRecord(event.payload) && event.payload.id === this.questionId) {
        handleQuestionPromptEvent(this.questionState, event);
      }
    });
    this.applyGatewaySnapshot(this.context.gateway.snapshot);
  }

  dispose(): void {
    this.stopGateway?.();
    this.stopGateway = undefined;
    this.stopGatewayEvents?.();
    this.stopGatewayEvents = undefined;
    this.operationGeneration += 1;
    this.client = null;
    disposeQuestionPromptState(this.questionState);
    if (
      this.previousDocumentTitle !== undefined &&
      (!this.activeDocumentTitle || document.title === this.activeDocumentTitle)
    ) {
      document.title = this.previousDocumentTitle;
    }
    this.previousDocumentTitle = undefined;
    this.activeDocumentTitle = undefined;
  }

  bindQuestionId(): void {
    if (this.boundQuestionId !== this.questionId) {
      this.boundQuestionId = this.questionId;
      this.operationGeneration += 1;
      this.requestError = this.questionId ? null : "unavailable";
      this.loading = Boolean(this.questionId);
      if (this.questionId && this.client) {
        void this.loadQuestion(this.client);
      }
      this.notify();
    }
  }

  documentTitle(): string {
    const prompt = listQuestionPrompts(this.questionState).find(
      (candidate) => candidate.id === this.questionId,
    );
    const title = `${this.pageTitle(prompt)} — ${t("approvalPage.brandName")}`;
    return title;
  }

  afterRender(title: string): void {
    document.title = title;
    this.activeDocumentTitle = title;
    if (this.questionPanelHadFocus && !this.host.querySelector("openclaw-chat-question-card")) {
      this.host.querySelector<HTMLElement>("#question-page-title")?.focus({ preventScroll: true });
    }
  }

  private applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot): void {
    try {
      const nextClient = snapshot.phase === "connected" ? snapshot.client : null;
      if (this.client === nextClient) {
        if (
          !nextClient &&
          (snapshot.lastError ||
            snapshot.phase === "offline" ||
            snapshot.phase === "reload-required" ||
            snapshot.phase === "stopped")
        ) {
          this.loading = false;
          this.requestError = "connection";
        }
        return;
      }
      this.operationGeneration += 1;
      this.client = nextClient;
      setQuestionPromptClient(this.questionState, nextClient);
      if (!nextClient) {
        if (
          listQuestionPrompts(this.questionState).some((prompt) => prompt.id === this.questionId)
        ) {
          this.loading = false;
          this.requestError = "connection";
        }
        return;
      }
      if (!this.questionId) {
        this.loading = false;
        this.requestError = "unavailable";
        return;
      }
      void this.loadQuestion(nextClient);
    } finally {
      this.notify();
    }
  }

  async loadQuestion(client: GatewayBrowserClient): Promise<void> {
    const id = this.questionId;
    const generation = ++this.operationGeneration;
    this.loading = true;
    this.requestError = null;
    this.notify();
    try {
      const result = await requestQuestionGateway(client, "question.get", { id });
      if (
        this.client !== client ||
        this.operationGeneration !== generation ||
        this.questionId !== id
      ) {
        return;
      }
      if (!isRecord(result) || !isRecord(result.question) || result.question.id !== id) {
        this.requestError = "unavailable";
        return;
      }
      const record = result.question;
      if (
        (record.status !== "pending" &&
          record.status !== "answered" &&
          record.status !== "cancelled" &&
          record.status !== "expired") ||
        !handleQuestionPromptEvent(this.questionState, {
          event: "question.requested",
          payload: { ...record, status: "pending" },
        })
      ) {
        this.requestError = "unavailable";
        return;
      }
      if (record.status === "answered") {
        const accepted = handleQuestionPromptEvent(this.questionState, {
          event: "question.resolved",
          payload: { id, status: "answered", answers: record.answers },
        });
        if (!accepted) {
          this.requestError = "unavailable";
        }
      } else if (record.status === "cancelled" || record.status === "expired") {
        handleQuestionPromptEvent(this.questionState, {
          event: "question.resolved",
          payload: { id, status: record.status },
        });
      }
    } catch (error) {
      if (this.client === client && this.operationGeneration === generation) {
        this.requestError = isQuestionNotFoundError(error) ? "unavailable" : "load";
      }
    } finally {
      if (this.client === client && this.operationGeneration === generation) {
        this.loading = false;
        this.notify();
      }
    }
  }

  questionStatusLabel(prompt: QuestionPrompt): string {
    return t(
      {
        answered: "chat.questions.answered",
        cancelled: "chat.questions.skipped",
        expired: "chat.questions.expired",
        pending: "chat.questions.unavailable",
        unavailable: "chat.questions.unavailable",
      }[prompt.status],
    );
  }

  pageTitle(prompt: QuestionPrompt | undefined): string {
    if (this.loading) {
      return t("common.loading");
    }
    if (this.requestError) {
      return t(
        this.requestError === "connection"
          ? "chat.questions.disconnected"
          : this.requestError === "load"
            ? "chat.questions.loadFailed"
            : "chat.questions.unavailable",
      );
    }
    return prompt && prompt.status !== "pending"
      ? this.questionStatusLabel(prompt)
      : t("chat.questions.eyebrow");
  }

  retry() {
    if (this.client) {
      void this.loadQuestion(this.client);
    }
  }
}

function QuestionSummary(props: { prompt: QuestionPrompt }) {
  const answer = (question: QuestionPrompt["questions"][number]) => {
    const prompt = props.prompt;
    if (prompt.status === "cancelled") {
      return t("chat.questions.skipped");
    }
    if (prompt.status === "expired") {
      return t("chat.questions.expired");
    }
    if (prompt.status === "unavailable") {
      return t("chat.questions.unavailable");
    }
    if (question.isSecret) {
      return t("chat.questions.answered");
    }
    return (
      prompt.answers?.answers[question.questionId]?.join(", ") ||
      t(prompt.answeredElsewhere ? "chat.questions.answeredElsewhere" : "chat.questions.answered")
    );
  };
  return (
    <div class="chat-question-summary" aria-label={t("chat.questions.summaryLabel")}>
      <For each={props.prompt.questions} keyed={(question) => question.questionId}>
        {(question) => (
          <div class="chat-question-summary__item">
            <div class="chat-question-summary__prompt">{question().question}</div>
            <div class="chat-question-summary__line">
              <strong>{question().header}:</strong>
              <span>{answer(question())}</span>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}

function QuestionPageContent(props: QuestionPageProps & { host: HTMLElement }) {
  const context = useApplication();
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const controller = new QuestionPageController(
    context,
    props,
    untrack(() => props.host),
    () => setRevision((value) => value + 1),
  );
  const read = () => {
    revision();
    return controller;
  };
  untrack(() => controller.connect());
  onCleanup(() => controller.dispose());
  createEffect(
    () => props.questionId,
    () => controller.bindQuestionId(),
  );
  createEffect(
    () => {
      revision();
      return controller.documentTitle();
    },
    (title) => controller.afterRender(title),
  );
  const panelProps = () => {
    const prompt = read().prompt;
    return prompt
      ? createGatewayQuestionPanelProps(prompt, {
          onChange: () => setRevision((value) => value + 1),
          onSubmit: (answers) => submitQuestionPrompt(controller.questionState, prompt.id, answers),
          onSkip: () => cancelQuestionPrompt(controller.questionState, prompt.id),
        })
      : undefined;
  };
  return (
    <main
      class="approval-page question-page"
      aria-labelledby="question-page-title"
      aria-busy={read().loading ? "true" : "false"}
      data-state={read().prompt?.status ?? read().requestError ?? "loading"}
    >
      <div class="approval-page__card approval-page__card--severity-info">
        <div class="approval-page__content">
          <Show
            when={
              read().loading ||
              read().requestError ||
              !read().prompt ||
              read().prompt?.status === "pending"
            }
          >
            <h1 id="question-page-title" class="sr-only" tabindex="-1">
              {read().pageTitle(read().prompt)}
            </h1>
          </Show>
          <Show
            when={!read().loading && !read().requestError}
            fallback={
              <div class="approval-page__state" role="status">
                {read().pageTitle(read().prompt)}
                <Show when={!read().loading && read().requestError === "load"}>
                  <button type="button" class="btn" onClick={() => controller.retry()}>
                    {t("common.retry")}
                  </button>
                </Show>
              </div>
            }
          >
            <Show when={read().prompt}>
              {(prompt) => (
                <Show
                  when={read().prompt?.status === "pending"}
                  fallback={
                    <div
                      class="approval-page__state"
                      data-question-status={prompt().status}
                      role="status"
                    >
                      <h1 id="question-page-title" tabindex="-1">
                        {read().questionStatusLabel(prompt())}
                      </h1>
                      <QuestionSummary prompt={prompt()} />
                    </div>
                  }
                >
                  <ChatQuestionCard props={panelProps()} />
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
  (props, host) => <QuestionPageContent questionId={props.questionId} host={host} />,
  { properties: { questionId: { default: "", attribute: "question-id" } } },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-question-page": SolidBridgeElement<QuestionPageProps>;
  }
}
