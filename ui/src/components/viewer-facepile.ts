import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import type { PresenceViewer } from "./viewer-presence.ts";
import "./tooltip.ts";

function presenceViewerLabel(user: PresenceViewer): string {
  return user.name ?? user.email ?? user.id;
}

function initialsFor(user: PresenceViewer): string {
  const label = presenceViewerLabel(user);
  const words = label
    .replace(/@.*$/u, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (words.length > 1) {
    return `${words[0]?.[0] ?? ""}${words.at(-1)?.[0] ?? ""}`.toUpperCase();
  }
  return (words[0] ?? label).slice(0, 2).toUpperCase();
}

function avatarColor(userId: string): string {
  let hash = 2166136261;
  for (const character of userId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `hsl(${(hash >>> 0) % 360} 48% 42%)`;
}

class ViewerFacepile extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) users: readonly PresenceViewer[] = [];
  @property({ type: Number, attribute: "max-visible" }) maxVisible = 3;
  @property() variant: "session" | "footer" = "session";

  override render() {
    if (this.users.length === 0) {
      return nothing;
    }
    const visible = this.users.slice(0, this.maxVisible);
    const overflow = this.users.slice(this.maxVisible);
    return html`<span
      class="viewer-facepile viewer-facepile--${this.variant}"
      data-viewer-count=${this.users.length}
      aria-label=${this.users.map(presenceViewerLabel).join(", ")}
    >
      ${visible.map((user) => {
        const label = presenceViewerLabel(user);
        return html`<openclaw-tooltip .content=${label}>
          <span class="viewer-avatar" data-viewer-id=${user.id} aria-label=${label}>
            ${user.avatarUrl
              ? html`<img src=${user.avatarUrl} alt="" referrerpolicy="no-referrer" />`
              : html`<span style=${`background: ${avatarColor(user.id)}`}
                  >${initialsFor(user)}</span
                >`}
          </span>
        </openclaw-tooltip>`;
      })}
      ${overflow.length > 0
        ? html`<openclaw-tooltip .content=${overflow.map(presenceViewerLabel).join("\n")}>
            <span
              class="viewer-avatar viewer-avatar--overflow"
              aria-label=${overflow.map(presenceViewerLabel).join(", ")}
              >+${overflow.length}</span
            >
          </openclaw-tooltip>`
        : nothing}
    </span>`;
  }
}

if (globalThis.customElements && !customElements.get("openclaw-viewer-facepile")) {
  customElements.define("openclaw-viewer-facepile", ViewerFacepile);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-viewer-facepile": ViewerFacepile;
  }
}
