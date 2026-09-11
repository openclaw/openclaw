// Profile-owned sharing of the person's own laptop sessions: mint a connect
// command bound to this profile, and see or stop what this profile shares.
import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import type {
  LocalSessionEnrollment,
  LocalSessionSourceDescriptor,
  SessionsLocalConnectCodeResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { renderConnectCommand } from "../../components/connect-command.ts";
import { renderSettingsEmpty, renderSettingsSection } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatTimeMs } from "../../lib/format.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

const CONNECT_CODE_METHOD = "sessions.local.connectCode";

export class ProfileLocalSessions extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: false })
  private context!: ApplicationContext;
  @state() private sources: LocalSessionSourceDescriptor[] = [];
  @state() private enrollments: LocalSessionEnrollment[] = [];
  @state() private selected = new Set<string>();
  @state() private minted: SessionsLocalConnectCodeResult | null = null;
  @state() private busy = false;
  @state() private error: string | null = null;
  private snapshot: ApplicationGatewaySnapshot | null = null;
  private generation = 0;
  private subscriptions: Array<() => void> = [];

  override connectedCallback() {
    super.connectedCallback();
    this.subscriptions = [
      this.context.gateway.subscribe((snapshot) => this.applySnapshot(snapshot)),
      this.context.gateway.subscribeEvents((event) => this.handleEvent(event)),
    ];
    this.applySnapshot(this.context.gateway.snapshot);
  }

  override disconnectedCallback() {
    for (const unsubscribe of this.subscriptions) {
      unsubscribe();
    }
    this.subscriptions = [];
    this.generation += 1;
    super.disconnectedCallback();
  }

  private get client(): GatewayBrowserClient | null {
    return this.snapshot?.phase === "connected" ? this.snapshot.client : null;
  }

  private get profileId(): string | null {
    const identity = this.snapshot?.selfUser?.identity;
    return identity?.type === "profile" ? identity.id : null;
  }

  private get available(): boolean {
    return isGatewayMethodAdvertised(this.snapshot ?? {}, CONNECT_CODE_METHOD) === true;
  }

  private applySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const previous = this.snapshot;
    this.snapshot = snapshot;
    const reconnected =
      !previous || previous.client !== snapshot.client || previous.phase !== snapshot.phase;
    if (reconnected) {
      this.generation += 1;
      this.minted = null;
      this.error = null;
      this.sources = [];
      this.enrollments = [];
      if (this.available && this.client) {
        void this.load(this.generation, this.client);
      }
    }
    this.requestUpdate();
  }

  private async load(generation: number, client: GatewayBrowserClient) {
    try {
      const [sources, enrollments] = await Promise.all([
        client.request<{ sources: LocalSessionSourceDescriptor[] }>("sessions.local.sources", {}),
        client.request<{ enrollments: LocalSessionEnrollment[] }>("sessions.local.enrollments", {}),
      ]);
      if (generation !== this.generation) {
        return;
      }
      this.sources = sources.sources;
      this.enrollments = enrollments.enrollments;
      this.selected = new Set(sources.sources.map((source) => source.sourceId));
    } catch (error) {
      if (generation === this.generation) {
        this.error = formatUiError(error);
      }
    }
  }

  private handleEvent(event: { event: string; payload?: unknown }) {
    if (event.event !== "sessions.local.enrollment") {
      return;
    }
    // SAFETY: sessions.local.enrollment payloads carry an `enrollment` object per the Gateway schema.
    const enrollment = (event.payload as { enrollment?: LocalSessionEnrollment } | null)
      ?.enrollment;
    if (!enrollment?.enrollmentId) {
      return;
    }
    this.enrollments = [
      ...this.enrollments.filter((row) => row.enrollmentId !== enrollment.enrollmentId),
      enrollment,
    ];
  }

  private toggleSource(sourceId: string, checked: boolean) {
    const next = new Set(this.selected);
    if (checked) {
      next.add(sourceId);
    } else {
      next.delete(sourceId);
    }
    this.selected = next;
  }

  private async mint() {
    const client = this.client;
    const generation = this.generation;
    if (!client || this.busy || this.selected.size === 0) {
      return;
    }
    this.busy = true;
    this.error = null;
    try {
      const result = await client.request<SessionsLocalConnectCodeResult>(CONNECT_CODE_METHOD, {
        sourceIds: [...this.selected],
        agentId: this.snapshot?.assistantAgentId ?? "main",
      });
      if (generation === this.generation) {
        this.minted = result;
      }
    } catch (error) {
      if (generation === this.generation) {
        this.error = formatUiError(error);
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
      }
    }
  }

  private async stopSharing(enrollmentId: string) {
    const client = this.client;
    const generation = this.generation;
    if (!client || this.busy) {
      return;
    }
    this.busy = true;
    this.error = null;
    try {
      const result = await client.request<{ enrollment: LocalSessionEnrollment }>(
        "sessions.local.revoke",
        { enrollmentId },
      );
      if (generation === this.generation) {
        this.handleEvent({ event: "sessions.local.enrollment", payload: result });
      }
    } catch (error) {
      if (generation === this.generation) {
        this.error = formatUiError(error);
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
      }
    }
  }

  private renderMint() {
    if (this.sources.length === 0) {
      return renderSettingsEmpty(t("profilePage.localSessions.noSources"));
    }
    const minted = this.minted;
    const expiresAt = minted
      ? formatTimeMs(minted.expiresAtMs, { hour: "numeric", minute: "2-digit" }, "")
      : "";
    return html`
      <div class="profile-local-sessions__mint">
        <div
          class="profile-local-sessions__sources"
          role="group"
          aria-label=${t("profilePage.localSessions.sourcesLabel")}
        >
          ${this.sources.map(
            (source) => html`
              <label class="profile-local-sessions__source">
                <input
                  type="checkbox"
                  data-source-id=${source.sourceId}
                  .checked=${this.selected.has(source.sourceId)}
                  ?disabled=${this.busy}
                  @change=${(event: Event) => {
                    if (event.target instanceof HTMLInputElement) {
                      this.toggleSource(source.sourceId, event.target.checked);
                    }
                  }}
                />
                ${source.label}
              </label>
            `,
          )}
        </div>
        <button
          class="btn primary"
          type="button"
          data-action="mint"
          ?disabled=${this.busy || this.selected.size === 0}
          @click=${() => void this.mint()}
        >
          ${
            this.busy && !minted
              ? t("profilePage.localSessions.minting")
              : minted
                ? t("profilePage.localSessions.freshCommand")
                : t("profilePage.localSessions.getCommand")
          }
        </button>
        ${
          minted
            ? html`
                ${renderConnectCommand(minted.command)}
                <p class="settings-row__desc">${t("profilePage.localSessions.commandHint")}</p>
                ${
                  expiresAt
                    ? html`<p class="settings-row__desc">
                        ${t("profilePage.localSessions.commandExpires", { time: expiresAt })}
                      </p>`
                    : nothing
                }
              `
            : nothing
        }
      </div>
    `;
  }

  private renderShared() {
    const own = this.enrollments
      .filter(
        (row) =>
          row.ownerProfileId === this.profileId &&
          (row.state === "pending" || row.state === "active"),
      )
      .toSorted((left, right) => right.requestedAtMs - left.requestedAtMs);
    if (own.length === 0) {
      return html`<p class="settings-row__desc">${t("profilePage.localSessions.sharedNone")}</p>`;
    }
    return html`
      <ul class="profile-local-sessions__shared">
        ${own.map(
          (row) => html`
            <li class="profile-local-sessions__enrollment" data-enrollment-id=${row.enrollmentId}>
              <span>
                ${t("profilePage.localSessions.sharedRow", {
                  source:
                    this.sources.find((s) => s.sourceId === row.sourceId)?.label ?? row.sourceId,
                  device: row.deviceId.slice(0, 8),
                  agent: row.agentId,
                })}
                <span class="settings-row__desc">
                  ${
                    row.state === "active"
                      ? t("profilePage.localSessions.stateActive")
                      : t("profilePage.localSessions.statePending")
                  }
                </span>
              </span>
              <button
                class="btn btn--sm danger"
                type="button"
                data-action="stop"
                ?disabled=${this.busy}
                @click=${() => void this.stopSharing(row.enrollmentId)}
              >
                ${t("profilePage.localSessions.stopSharing")}
              </button>
            </li>
          `,
        )}
      </ul>
    `;
  }

  override render() {
    if (!this.snapshot || this.snapshot.phase !== "connected" || !this.available) {
      return nothing;
    }
    const canWrite = hasOperatorWriteAccess(this.snapshot.hello?.auth ?? null);
    const body = !this.profileId
      ? renderSettingsEmpty(t("profilePage.localSessions.profileRequired"))
      : !canWrite
        ? renderSettingsEmpty(t("profilePage.localSessions.writeRequired"))
        : html`
            ${this.error ? html`<p class="settings-error" role="alert">${this.error}</p>` : nothing}
            ${this.renderMint()}
            <h4 class="profile-local-sessions__heading">
              ${t("profilePage.localSessions.sharedTitle")}
            </h4>
            ${this.renderShared()}
          `;
    return html`<div id="profile-local-sessions">
      ${renderSettingsSection(
        {
          title: t("profilePage.localSessions.title"),
          description: t("profilePage.localSessions.description"),
        },
        html`<div class="profile-local-sessions">${body}</div>`,
      )}
    </div>`;
  }
}

if (!customElements.get("openclaw-profile-local-sessions")) {
  customElements.define("openclaw-profile-local-sessions", ProfileLocalSessions);
}
