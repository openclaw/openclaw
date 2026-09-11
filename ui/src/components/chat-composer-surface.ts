import { html, nothing, type TemplateResult } from "lit";
import { ref, type RefOrCallback } from "lit/directives/ref.js";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";
import "../styles/rail-header.css";
import "../styles/chat/startup-layout.css";
import "../styles/chat/composer-surface.css";

type ComposerContent = TemplateResult | typeof nothing;

type ChatComposerSurfaceInput = {
  offline?: boolean;
  dictating?: boolean;
  busy?: boolean;
  inputRef?: RefOrCallback;
  events?: {
    show: (event: Event) => void;
    afterShow: (event: Event) => void;
    dismissInvocations: () => void;
    click: (event: MouseEvent) => void;
    pointerDown: (event: PointerEvent) => void;
  };
  menus?: ComposerContent;
  lede?: ComposerContent;
  editor: ComposerContent;
  lead: ComposerContent;
  context?: ComposerContent;
  controls?: ComposerContent;
  reserveControls?: boolean;
  actions: ComposerContent;
};

export function renderChatComposerSurface(props: {
  questionComposer?: boolean;
  overlay?: ComposerContent;
  beforeInput?: ComposerContent;
  afterInput?: ComposerContent;
  input?: ChatComposerSurfaceInput;
}) {
  const input = props.input;
  return html`
    <div
      class="agent-chat__composer-shell ${
        props.questionComposer ? "agent-chat__composer-shell--question-composer" : ""
      }"
    >
      <div class="agent-chat__composer-overlay">${props.overlay}</div>
      ${props.beforeInput}
      ${
        input
          ? html`
              <div
                class="agent-chat__input agent-chat__input--chat agent-chat__input--mobile-toolbar ${input.offline ? "agent-chat__input--offline" : ""}${input.dictating ? " agent-chat__input--dictating" : ""}"
                aria-busy=${input.busy ? "true" : "false"}
                @wa-show=${input.events?.show}
                @wa-after-show=${input.events?.afterShow}
                @openclaw-composer-dismiss-invocations=${input.events?.dismissInvocations}
                @click=${input.events?.click}
                @pointerdown=${input.events?.pointerDown}
                ${ref(input.inputRef)}
              >
                ${input.menus}
                <div class="agent-chat__composer-lede">${input.lede}</div>
                <div class="agent-chat__composer-input-row">
                  <div class="agent-chat__composer-combobox">${input.editor}</div>
                </div>
                <div class="agent-chat__composer-footer">
                  <div class="agent-chat__composer-lead agent-chat__composer-meta">
                    ${input.lead}
                  </div>
                  <div class="agent-chat__composer-trail">
                    <div class="agent-chat__composer-meta agent-chat__composer-context">
                      ${input.context}
                    </div>
                    ${input.reserveControls || (input.controls && input.controls !== nothing) ? html`<div class="agent-chat__composer-controls ${input.reserveControls ? "agent-chat__composer-controls--reserved" : ""}">${input.controls}</div>` : nothing}
                    <div class="agent-chat__composer-actions">${input.actions}</div>
                  </div>
                </div>
              </div>
            `
          : nothing
      }
      ${props.afterInput}
    </div>
  `;
}

export function renderPendingChatComposer(placeholder: string, reservedHeight?: number) {
  if (reservedHeight !== undefined) {
    return renderChatComposerSurface({
      beforeInput: html`<div style="height:${reservedHeight}px"></div>`,
    });
  }
  return renderChatComposerSurface({
    input: {
      reserveControls: true,
      editor: html`<textarea disabled placeholder=${placeholder} rows="1"></textarea>`,
      lead: html`<span class="agent-chat__attach-menu agent-chat__capability-menu"
        ><button type="button" class="agent-chat__input-btn agent-chat__input-btn--attach" disabled>
          ${icons.plus}
        </button></span
      >`,
      actions: html`<span class="chat-mobile-primary-action chat-desktop-primary-action">
        <button class="chat-send-btn chat-send-btn--send" disabled>
          ${icons.arrowUp}
          <span class="agent-chat__control-label">${t("chat.runControls.send")}</span>
        </button>
      </span>`,
    },
  });
}
