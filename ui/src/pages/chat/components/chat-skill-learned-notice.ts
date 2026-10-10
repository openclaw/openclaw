import { consume } from "@lit/context";
import type { SkillsWorkshopUndoResult } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { SkillWorkshopChangeNotice } from "../../../../../src/shared/skill-workshop-change-notice.js";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { toolIcons } from "../../../components/icons-tools.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../../lib/gateway-methods.ts";
import { normalizeAgentId } from "../../../lib/sessions/session-key.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import "../../../styles/chat/skill-learned-notice.css";

type UndoState = "idle" | "pending" | "done" | { error: string };

/**
 * A background skill review's changes as one divider row: each skill opens in the Workshop,
 * and Undo reverts the whole review through `skills.workshop.undo`, which also tells the agent.
 */
class ChatSkillLearnedNotice extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;
  @property({ attribute: false }) notice?: SkillWorkshopChangeNotice;
  private undo: UndoState = "idle";

  private readonly runUndo = async () => {
    const notice = this.notice;
    const snapshot = this.context?.gateway.snapshot;
    const client = snapshot?.phase === "connected" ? snapshot.client : null;
    if (!notice || !client || this.undo === "pending" || this.undo === "done") {
      return;
    }
    this.undo = "pending";
    this.requestUpdate();
    try {
      // "already-undone" is a success too: the review's changes are reverted either way.
      await client.request<SkillsWorkshopUndoResult>("skills.workshop.undo", {
        agentId: notice.agentId,
        runId: notice.runId,
      });
      this.undo = "done";
    } catch (error) {
      this.undo = { error: formatUiError(error) };
    }
    this.requestUpdate();
  };

  // The Workshop shows the selected agent's skills; the notice names whose skills changed.
  private openSkill(agentId: string, name: string) {
    this.context?.agentSelection.set(normalizeAgentId(agentId));
    this.context?.navigate("skill-workshop", { search: `?skill=${encodeURIComponent(name)}` });
  }

  private renderUndo() {
    if (this.undo === "done") {
      return html`<span class="chat-skill-notice__done" role="status"
        >${icons.check}${t("chat.skillLearned.undone")}</span
      >`;
    }
    if (
      !canCallGatewayMethod(
        this.context?.gateway.snapshot,
        "skills.workshop.undo",
        "operator.admin",
      )
    ) {
      return nothing;
    }
    const pending = this.undo === "pending";
    return html`<button
      type="button"
      class="chat-skill-notice__undo"
      ?disabled=${pending}
      aria-busy=${pending ? "true" : "false"}
      @click=${this.runUndo}
    >
      ${pending ? html`<span class="btn__spinner" aria-hidden="true"></span>` : toolIcons.rotateCcw}
      ${pending ? t("chat.skillLearned.undoing") : t("chat.skillLearned.undo")}
    </button>`;
  }

  // Mirrors the Carapace turn recap: hairline rules around one muted line of text.
  override render() {
    const notice = this.notice;
    if (!notice) {
      return nothing;
    }
    const undo = this.undo;
    return html`
      <div
        class="chat-skill-notice ${undo === "done" ? "chat-skill-notice--undone" : ""}"
        role="group"
        aria-label=${t("chat.skillLearned.label")}
      >
        <div class="chat-skill-notice__line">
          <span class="chat-skill-notice__icon" aria-hidden="true">${toolIcons.lightbulb}</span>
          <span class="chat-skill-notice__label">${t("chat.skillLearned.label")}</span>
          ${notice.skills.map((skill) => {
            const verb = t(`chat.skillLearned.${skill.action}`);
            const open = t("chat.skillLearned.open", { name: skill.name });
            return html`<span class="chat-skill-notice__skill">
              <span class="chat-skill-notice__sep" aria-hidden="true">·</span>
              ${verb}
              <button
                type="button"
                class="chat-skill-notice__name"
                title=${skill.summary ? `${skill.summary}\n${open}` : open}
                aria-label=${`${verb} ${skill.name}${skill.summary ? `: ${skill.summary}` : ""}. ${open}`}
                @click=${() => this.openSkill(notice.agentId, skill.name)}
              >
                ${skill.name}
              </button>
            </span>`;
          })}
          ${this.renderUndo()}
        </div>
        ${
          typeof undo === "object"
            ? html`<p class="chat-skill-notice__error" role="alert">
                ${t("chat.skillLearned.undoError", { error: undo.error })}
              </p>`
            : nothing
        }
      </div>
    `;
  }
}

if (!customElements.get("openclaw-chat-skill-learned-notice")) {
  customElements.define("openclaw-chat-skill-learned-notice", ChatSkillLearnedNotice);
}
