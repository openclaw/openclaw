import { ContextConsumer } from "@lit/context";
import { html, nothing, render, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import type { UsersListResult } from "../../../packages/gateway-protocol/src/schema/users.js";
import { buildControlUiUserAvatarPath } from "../../../src/gateway/control-ui-user-avatar-route.js";
import { selectApplicationSession } from "../app/agent-selection.ts";
import { applicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import {
  presenceMatchesProfile,
  projectPresencePayload,
  type PresenceViewer,
} from "../lib/presence-users.ts";
import {
  prepareSessionNavigationHandoff,
  runSessionNavigationIntent,
} from "../lib/sessions/navigation-handoff.ts";
import {
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../lib/sessions/route-navigation.ts";
import {
  isUiGlobalScopeConfigured,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
} from "../lib/sessions/session-key.ts";
import { GatewayPageController } from "../lit/gateway-page-controller.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import {
  identityAvatarClass,
  renderIdentityAvatarImage,
  resolveIdentityAvatarView,
} from "./identity-avatar-view.ts";
import { renderPersonActivityCard } from "./person-activity-card.ts";
import { observePersonActivityData } from "./person-activity-data.ts";
import { personActivityRouting } from "./person-activity-link.ts";
import { createPortaledHovercard, PortaledHovercardController } from "./portaled-hovercard.ts";
import "../styles/chat/person-reference.css";

let nextCardId = 0;

/** Explicit transcript selections only. The directory remains Gateway-owned, not a UI name index. */
class PersonReference extends OpenClawLightDomContentsElement {
  private static readonly active = new WeakMap<Document, PersonReference>();
  @property({ attribute: "profile-id" }) profileId = "";
  @property() label = "";
  private readonly context = new ContextConsumer(this, {
    context: applicationContext,
    subscribe: true,
  });
  private readonly connection = new GatewayPageController(this, {
    getGateway: () => this.context.value?.gateway,
    invalidateRequests: () => this.close(),
  });
  private readonly portal = new PortaledHovercardController(() => this.close());
  private stopRoute: (() => void) | undefined;
  private person: PresenceViewer | null | undefined;
  private activity: ReturnType<typeof observePersonActivityData> | undefined;

  override createRenderRoot() {
    // The sanitized HTML carries a readable fallback until this element upgrades.
    this.replaceChildren();
    return super.createRenderRoot();
  }

  override disconnectedCallback() {
    this.close();
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("profileId")) {
      this.close();
    }
  }

  protected override updated() {
    // Keep Lit boundary nodes, but exclude template indentation from copied table text.
    for (const node of this.trigger?.childNodes ?? []) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent && !node.textContent.trim()) {
        node.textContent = "";
      }
    }
    if (this.portal.card) {
      this.renderCard();
    }
  }

  private get trigger() {
    return this.querySelector<HTMLButtonElement>("button");
  }

  private readonly close = () => {
    if (PersonReference.active.get(this.ownerDocument) === this) {
      PersonReference.active.delete(this.ownerDocument);
    }
    this.activity?.dispose();
    this.activity = undefined;
    this.stopRoute?.();
    this.stopRoute = undefined;
    document.removeEventListener("pointerdown", this.outside, true);
    document.removeEventListener("focusin", this.outside, true);
    document.removeEventListener("keydown", this.escape, true);
    this.portal.reset();
    this.person = undefined;
    this.trigger?.setAttribute("aria-expanded", "false");
    this.trigger?.setAttribute("aria-haspopup", "dialog");
  };

  private readonly outside = (event: Event) => {
    if (!event.composedPath().some((target) => target === this || target === this.portal.card)) {
      this.close();
    }
  };

  private readonly escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const restore = this.portal.card?.contains(document.activeElement);
    const trigger = this.trigger;
    this.close();
    if (restore) {
      this.portal.returnFocus(trigger);
    }
  };

  private open() {
    const trigger = this.trigger;
    if (!trigger || !this.profileId || this.portal.card) {
      return;
    }
    PersonReference.active.get(this.ownerDocument)?.close();
    PersonReference.active.set(this.ownerDocument, this);
    const card = createPortaledHovercard(
      "openclaw-person-reference-" + ++nextCardId,
      "session-progress-hovercard person-activity-hovercard",
    );
    this.portal.markTrigger(trigger);
    card.addEventListener("keydown", this.portal.handleCardKeyDown);
    card.addEventListener("pointerleave", () => {
      this.portal.pointerOverCard = false;
      this.portal.scheduleClose();
    });
    this.portal.mount(trigger, card, "vertical", true, () => render(nothing, card));
    document.addEventListener("pointerdown", this.outside, true);
    document.addEventListener("focusin", this.outside, true);
    document.addEventListener("keydown", this.escape, true);
    const context = this.context.value;
    this.stopRoute = context?.router.subscribe(() => this.close());
    if (context) {
      this.activity = observePersonActivityData(context, () => this.renderCard());
    }
    this.person = this.connection.capture() ? undefined : null;
    this.renderCard();
    void this.loadPerson(card);
  }

  private async loadPerson(card: HTMLDivElement) {
    const scope = this.connection.capture();
    const context = this.context.value;
    const profileId = this.profileId;
    if (!scope || !context) {
      return;
    }
    let person: PresenceViewer | null = null;
    try {
      const { profiles } = await scope.client.request<UsersListResult>("users.list", {});
      // Follow only canonical merge edges returned by the authorized directory.
      const byId = new Map(profiles.map((profile) => [profile.id, profile]));
      const visited = new Set<string>();
      let profile = byId.get(profileId);
      while (profile?.mergedInto && !visited.has(profile.id)) {
        visited.add(profile.id);
        profile = byId.get(profile.mergedInto);
      }
      if (profile && !profile.mergedInto) {
        person = {
          id: profile.id,
          identity: { type: "profile", id: profile.id },
          name:
            profile.displayName?.trim() ||
            profile.githubIdentity?.login ||
            t("presence.card.person"),
          avatarUrl: profile.hasAvatar
            ? buildControlUiUserAvatarPath(profile.id, profile.updatedAt)
            : undefined,
          watchedSessions: [],
        };
      }
    } catch {
      // An unavailable or unauthorized profile remains an explicit, unresolved reference.
    }
    if (
      this.portal.card !== card ||
      this.profileId !== profileId ||
      this.context.value !== context ||
      !this.connection.isCurrent(scope)
    ) {
      return;
    }
    this.person = person;
    this.renderCard();
  }

  private renderCard() {
    const card = this.portal.card;
    const context = this.context.value;
    if (!card) {
      return;
    }
    card.setAttribute(
      "aria-label",
      t("presence.card.ariaLabel", { name: this.person?.name ?? this.label }),
    );
    const data = this.activity?.data;
    const presence = projectPresencePayload(data?.presencePayload).users.find((user) =>
      presenceMatchesProfile(user, this.person?.identity),
    );
    const user = this.person && {
      ...this.person,
      name: presence?.name ?? this.person.name,
      avatarUrl: presence?.avatarUrl ?? this.person.avatarUrl,
      watchedSessions: presence?.watchedSessions ?? [],
      entries: presence?.entries ?? (data?.presencePayload ? [] : undefined),
    };
    const defaults = {
      agentsList: context?.agents.state.agentsList,
      hello: context?.gateway.snapshot.hello,
    };
    const scope = this.connection.capture();
    const route = context?.router.getState().location;
    this.portal.renderContents(card, () =>
      render(
        user && context
          ? renderPersonActivityCard({
              user,
              sessionData: data,
              watchAgentId: resolveUiDefaultAgentId(defaults),
              mainKey: resolveUiConfiguredMainKey(defaults),
              globalScope: isUiGlobalScopeConfigured(defaults),
              routing: personActivityRouting(context, this.close),
              openSession: (row, agentId) => {
                const face = resolveSessionPreferredFace(row);
                const target = sessionNavigationTarget({
                  face,
                  sessionKey: row.key,
                  row,
                  fallbackAgentId: agentId,
                  basePath: context.basePath,
                  mainKey: resolveUiConfiguredMainKey(defaults),
                });
                this.close();
                runSessionNavigationIntent(this, {
                  agentId,
                  face,
                  sessionKey: row.key,
                  commit: () => {
                    if (
                      !scope ||
                      this.context.value !== context ||
                      context.router.getState().location !== route ||
                      !this.connection.isCurrent(scope)
                    ) {
                      return false;
                    }
                    prepareSessionNavigationHandoff(
                      context.gateway,
                      target.options.pathname,
                      row.key,
                    );
                    context.navigate(face, target.options);
                    selectApplicationSession({
                      selection: context.agentSelection,
                      gateway: context.gateway,
                      sessionKey: row.key,
                      agentId,
                    });
                    return true;
                  },
                });
              },
            })
          : html`<div class="person-reference__status" role="status">
              ${this.person === undefined ? t("common.loading") : t("chat.mentions.unavailable")}
            </div>`,
        card,
      ),
    );
    this.portal.position();
  }

  override render() {
    // The avatar route follows merged profiles; rendering a mention needs no directory read.
    const avatar = resolveIdentityAvatarView({
      id: this.profileId,
      identity: { type: "profile", id: this.profileId },
      name: this.label.replace(/^@/u, ""),
    });
    const face = html`<span
      class=${identityAvatarClass("markdown-person-reference__avatar", avatar)}
      aria-hidden="true"
      data-initials=${avatar.fallback.initials}
      >${renderIdentityAvatarImage({
        view: avatar,
        fallbackSelector: ".markdown-person-reference__avatar",
        ariaHidden: true,
      })}</span
    >`;
    const displayLabel = this.label.startsWith("@")
      ? html`<span class="markdown-person-reference__prefix" aria-hidden="true">@</span
          >${this.label.slice(1)}`
      : this.label;
    return html`<button
      type="button"
      class="markdown-person-reference"
      aria-haspopup="dialog"
      aria-expanded="false"
      aria-label=${t("presence.card.ariaLabel", { name: this.label })}
      @pointerenter=${(event: PointerEvent) => {
        if (event.pointerType === "touch") {
          return;
        }
        this.portal.pointerInside = true;
        this.portal.clearClose();
        this.portal.scheduleOpen(250, () => {
          if (this.portal.held) {
            this.open();
          }
        });
      }}
      @pointerleave=${() => this.portal.schedulePointerExit()}
      @pointercancel=${this.close}
      @contextmenu=${this.close}
      @focus=${() => {
        if (this.portal.restoringFocus) {
          return;
        }
        this.portal.focusInside = true;
        this.portal.clearClose();
        this.open();
      }}
      @blur=${() => {
        this.portal.focusInside = false;
        this.portal.scheduleClose();
      }}
      @keydown=${this.portal.handleTriggerKeyDown}
      @click=${() => {
        if (this.portal.explicitHold) {
          this.close();
          return;
        }
        this.portal.explicitHold = true;
        this.open();
      }}
    >
      ${face}${displayLabel}
    </button>`;
  }
}

if (!customElements.get("openclaw-person-reference")) {
  customElements.define("openclaw-person-reference", PersonReference);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-person-reference": PersonReference;
  }
}
