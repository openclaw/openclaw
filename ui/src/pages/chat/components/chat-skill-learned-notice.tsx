import type { SkillsWorkshopUndoResult } from "@openclaw/gateway-protocol";
import { render } from "@solidjs/web";
import { For, Show, createMemo, createSignal } from "solid-js";
import type { SkillWorkshopChangeNotice } from "../../../../../src/shared/skill-workshop-change-notice.js";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { t } from "../../../i18n/index.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../../lib/gateway-methods.ts";
import { normalizeAgentId } from "../../../lib/sessions/session-key.ts";
import "../../../styles/chat/skill-learned-notice.css";

type UndoState = "idle" | "pending" | "done" | { error: string };

function SkillLearnedNotice(props: {
  notice: SkillWorkshopChangeNotice | undefined;
  context: ApplicationContext | undefined;
}) {
  const [undo, setUndo] = createSignal<UndoState>("idle");
  const pending = createMemo(() => undo() === "pending");
  const error = createMemo(() => {
    const state = undo();
    return typeof state === "object" ? state.error : undefined;
  });
  // Signal writes commit asynchronously; guard repeated clicks synchronously.
  let undoStarted = false;
  const runUndo = async () => {
    const notice = props.notice;
    const snapshot = props.context?.gateway.snapshot;
    const client = snapshot?.phase === "connected" ? snapshot.client : null;
    if (!notice || !client || undoStarted) {
      return;
    }
    undoStarted = true;
    setUndo("pending");
    try {
      // "already-undone" also means the review's changes have been reverted.
      await client.request<SkillsWorkshopUndoResult>("skills.workshop.undo", {
        agentId: notice.agentId,
        runId: notice.runId,
      });
      setUndo("done");
    } catch (cause) {
      undoStarted = false;
      setUndo({ error: formatUiError(cause) });
    }
  };

  return (
    <Show when={props.notice}>
      {(notice) => (
        <div
          class={["chat-skill-notice", { "chat-skill-notice--undone": undo() === "done" }]}
          role="group"
          aria-label={t("chat.skillLearned.label")}
        >
          <div class="chat-skill-notice__line">
            <span class="chat-skill-notice__icon" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
                <path d="M9 18h6" />
                <path d="M10 22h4" />
              </svg>
            </span>
            <span class="chat-skill-notice__label">{t("chat.skillLearned.label")}</span>
            <For each={notice().skills} keyed={false}>
              {(skill) => {
                const verb = createMemo(() => t(`chat.skillLearned.${skill().action}`));
                const open = createMemo(() => t("chat.skillLearned.open", { name: skill().name }));
                return (
                  <span class="chat-skill-notice__skill">
                    <span class="chat-skill-notice__sep" aria-hidden="true">
                      ·
                    </span>
                    {verb()}
                    <button
                      type="button"
                      class="chat-skill-notice__name"
                      title={skill().summary ? `${skill().summary}\n${open()}` : open()}
                      aria-label={`${verb()} ${skill().name}${skill().summary ? `: ${skill().summary}` : ""}. ${open()}`}
                      onClick={() => {
                        props.context?.agentSelection.set(normalizeAgentId(notice().agentId));
                        props.context?.navigate("skill-workshop", {
                          search: `?skill=${encodeURIComponent(skill().name)}`,
                        });
                      }}
                    >
                      {skill().name}
                    </button>
                  </span>
                );
              }}
            </For>
            <Show
              when={undo() === "done"}
              fallback={
                <Show
                  when={canCallGatewayMethod(
                    props.context?.gateway.snapshot,
                    "skills.workshop.undo",
                    "operator.admin",
                  )}
                >
                  <button
                    type="button"
                    class="chat-skill-notice__undo"
                    disabled={pending()}
                    aria-busy={pending() ? "true" : "false"}
                    onClick={runUndo}
                  >
                    <Show
                      when={pending()}
                      fallback={
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5" />
                        </svg>
                      }
                    >
                      <span class="btn__spinner" aria-hidden="true" />
                    </Show>
                    {pending() ? t("chat.skillLearned.undoing") : t("chat.skillLearned.undo")}
                  </button>
                </Show>
              }
            >
              <span class="chat-skill-notice__done" role="status">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                {t("chat.skillLearned.undone")}
              </span>
            </Show>
          </div>
          <Show when={error()}>
            {(message) => (
              <p class="chat-skill-notice__error" role="alert">
                {t("chat.skillLearned.undoError", { error: message() })}
              </p>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}

class ApplicationContextRequest extends Event {
  readonly context = applicationContext;
  readonly subscribe = true;

  constructor(
    readonly contextTarget: Element,
    readonly callback: (value: ApplicationContext, unsubscribe?: () => void) => void,
  ) {
    super("context-request", { bubbles: true, composed: true });
  }
}

class ChatSkillLearnedNoticeHost extends HTMLElement {
  private readonly readNotice: () => SkillWorkshopChangeNotice | undefined;
  private readonly writeNotice: (value: SkillWorkshopChangeNotice | undefined) => void;
  private readonly readContext: () => ApplicationContext | undefined;
  private readonly writeContext: (value: ApplicationContext | undefined) => void;
  private directContext = false;
  private dispose?: () => void;
  private unsubscribe?: () => void;
  onDisconnect?: () => void;

  constructor() {
    super();
    const [notice, setNotice] = createSignal<SkillWorkshopChangeNotice>();
    const [context, setContext] = createSignal<ApplicationContext>();
    this.readNotice = notice;
    this.writeNotice = setNotice;
    this.readContext = context;
    this.writeContext = setContext;
  }

  set notice(value: SkillWorkshopChangeNotice | undefined) {
    this.writeNotice(value);
  }

  set context(value: ApplicationContext | undefined) {
    this.directContext = value !== undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.writeContext(value);
  }

  connectedCallback() {
    if (!this.directContext) {
      this.dispatchEvent(
        new ApplicationContextRequest(this, (value, unsubscribe) => {
          if (this.unsubscribe !== unsubscribe) {
            this.unsubscribe?.();
          }
          this.unsubscribe = unsubscribe;
          this.writeContext(value);
        }),
      );
    }
    this.dispose = render(
      () => <SkillLearnedNotice notice={this.readNotice()} context={this.readContext()} />,
      this,
    );
  }

  disconnectedCallback() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.dispose?.();
    this.dispose = undefined;
    this.onDisconnect?.();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-skill-learned-notice": ChatSkillLearnedNoticeHost;
  }
}

if (!customElements.get("openclaw-chat-skill-learned-notice")) {
  customElements.define("openclaw-chat-skill-learned-notice", ChatSkillLearnedNoticeHost);
}
