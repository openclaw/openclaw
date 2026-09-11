// Devices page: per-node "Live local sessions" sharing. A connected node offers
// a source when it advertises that source's command; the enrollment rows come
// from the Gateway and change only through sessions.local.* events.
import { html, nothing, type TemplateResult } from "lit";
import type {
  LocalSessionEnrollment,
  LocalSessionSourceDescriptor,
} from "../../../../packages/gateway-protocol/src/schema/sessions-local.js";
import "../../components/agent-select-registration.ts";
import { renderCopyButton } from "../../components/copy-button.ts";
import { renderSettingsStatus } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { resolveConfigAgents } from "./view-shared.ts";

export type { LocalSessionSourceDescriptor };

export type LocalSessionSharingProps = {
  sources: LocalSessionSourceDescriptor[];
  enrollments: LocalSessionEnrollment[];
  /** Signed-in team profile; the Gateway refuses enroll/revoke without one. */
  selfProfileId: string | null;
  canWrite: boolean;
  canAdmin: boolean;
  selectedAgentByDevice: Record<string, string>;
  /** `${deviceId}:${sourceId}` while sharing, or the enrollmentId while stopping. */
  busyKey: string | null;
  error: { deviceId: string; message: string } | null;
  onSelectAgent: (deviceId: string, agentId: string) => void;
  onShare: (deviceId: string, sourceId: string, agentId: string) => void;
  onStopSharing: (enrollmentId: string) => void;
};

type LocalSessionEnrollmentView =
  | { kind: "none"; last?: LocalSessionEnrollment }
  | { kind: "pending"; enrollment: LocalSessionEnrollment }
  | { kind: "active"; enrollment: LocalSessionEnrollment };

function offeredLocalSessionSources(
  sources: LocalSessionSourceDescriptor[],
  commands: readonly string[],
): LocalSessionSourceDescriptor[] {
  const advertised = new Set(commands);
  return sources.filter((source) => advertised.has(source.command));
}

/** One live row wins: active over pending; otherwise the latest ended request explains itself. */
function resolveLocalSessionEnrollmentView(
  enrollments: readonly LocalSessionEnrollment[],
  deviceId: string,
  sourceId: string,
): LocalSessionEnrollmentView {
  const rows = enrollments.filter(
    (enrollment) => enrollment.deviceId === deviceId && enrollment.sourceId === sourceId,
  );
  const latest = (candidates: LocalSessionEnrollment[]) =>
    candidates.toSorted((left, right) => right.requestedAtMs - left.requestedAtMs)[0];
  const active = latest(rows.filter((enrollment) => enrollment.state === "active"));
  if (active) {
    return { kind: "active", enrollment: active };
  }
  const pending = latest(rows.filter((enrollment) => enrollment.state === "pending"));
  if (pending) {
    return { kind: "pending", enrollment: pending };
  }
  const last = latest(rows);
  return last ? { kind: "none", last } : { kind: "none" };
}

function localSessionAcceptCommand(enrollmentId: string): string {
  return `openclaw sessions share --accept ${enrollmentId}`;
}

function resolveShareAgents(configForm: Record<string, unknown> | null) {
  const agents = resolveConfigAgents(configForm).map((agent) => ({
    id: agent.id,
    name: agent.name,
    isDefault: agent.isDefault,
  }));
  if (agents.length === 0) {
    return [{ id: "main", name: undefined, isDefault: true }];
  }
  return agents;
}

function endedStateLabel(state: LocalSessionEnrollment["state"]): string | null {
  switch (state) {
    case "declined":
      return t("devices.localSessions.stateDeclined");
    case "expired":
      return t("devices.localSessions.stateExpired");
    case "revoked":
      return t("devices.localSessions.stateRevoked");
    default:
      return null;
  }
}

function renderLastRequest(last: LocalSessionEnrollment | undefined) {
  const state = last ? endedStateLabel(last.state) : null;
  if (!last || !state) {
    return nothing;
  }
  return html`<span class="settings-row__desc"
    >${
      last.reason
        ? t("devices.localSessions.lastRequestReason", { state, reason: last.reason })
        : t("devices.localSessions.lastRequest", { state })
    }</span
  >`;
}

function renderShareControls(
  deviceId: string,
  source: LocalSessionSourceDescriptor,
  props: LocalSessionSharingProps,
  configForm: Record<string, unknown> | null,
) {
  const agents = resolveShareAgents(configForm);
  const selectedAgent =
    props.selectedAgentByDevice[deviceId] ??
    (agents.find((agent) => agent.isDefault) ?? agents[0])?.id ??
    "main";
  const disabledReason = !props.canWrite
    ? t("devices.localSessions.writeRequired")
    : props.selfProfileId === null
      ? t("devices.localSessions.profileRequired")
      : "";
  const busy = props.busyKey === `${deviceId}:${source.sourceId}`;
  const options = agents.map((agent) => ({
    value: agent.id,
    label: agent.name?.trim() ? `${agent.name} (${agent.id})` : agent.id,
    agent: { id: agent.id, ...(agent.name ? { name: agent.name } : {}) },
    badge: agent.isDefault ? t("agents.default") : undefined,
  }));
  return html`
    <openclaw-agent-select
      class="agent-select--settings"
      .options=${options}
      .value=${selectedAgent}
      .accessibleLabel=${t("devices.localSessions.agent")}
      .disabled=${Boolean(disabledReason) || busy}
      .onSelect=${(agentId: string) => props.onSelectAgent(deviceId, agentId)}
    ></openclaw-agent-select>
    <button
      class="btn btn--sm"
      title=${disabledReason}
      ?disabled=${Boolean(disabledReason) || busy}
      @click=${() => props.onShare(deviceId, source.sourceId, selectedAgent)}
    >
      ${t("devices.localSessions.share", { source: source.label })}
    </button>
  `;
}

function renderStopSharing(enrollment: LocalSessionEnrollment, props: LocalSessionSharingProps) {
  const owns = props.selfProfileId !== null && enrollment.ownerProfileId === props.selfProfileId;
  const disabledReason = !props.canWrite
    ? t("devices.localSessions.writeRequired")
    : !owns && !props.canAdmin
      ? t("devices.localSessions.ownerRequired")
      : "";
  const busy = props.busyKey === enrollment.enrollmentId;
  return html`<button
    class="btn btn--sm danger"
    title=${disabledReason}
    ?disabled=${Boolean(disabledReason) || busy}
    @click=${() => props.onStopSharing(enrollment.enrollmentId)}
  >
    ${t("devices.localSessions.stopSharing")}
  </button>`;
}

function renderSource(
  deviceId: string,
  source: LocalSessionSourceDescriptor,
  props: LocalSessionSharingProps,
  configForm: Record<string, unknown> | null,
): TemplateResult {
  const view = resolveLocalSessionEnrollmentView(props.enrollments, deviceId, source.sourceId);
  const status =
    view.kind === "active"
      ? renderSettingsStatus({ kind: "ok", label: t("devices.localSessions.statusShared") })
      : view.kind === "pending"
        ? renderSettingsStatus({ kind: "warn", label: t("devices.localSessions.statusPending") })
        : renderSettingsStatus({
            kind: "muted",
            label: t("devices.localSessions.statusNotShared"),
          });
  const command =
    view.kind === "pending" ? localSessionAcceptCommand(view.enrollment.enrollmentId) : null;
  return html`
    <div class="device-local-session" data-source-id=${source.sourceId} data-state=${view.kind}>
      <div class="device-entry__heading">
        <span class="settings-row__title"
          >${t("devices.localSessions.sourceSessions", { source: source.label })}</span
        >
        <span class="device-entry__status">${status}</span>
      </div>
      ${
        view.kind === "active"
          ? html`<span class="settings-row__desc"
              >${t("devices.localSessions.active", {
                owner: view.enrollment.ownerLabel,
                agent: view.enrollment.agentId,
              })}</span
            >`
          : view.kind === "pending"
            ? html`<span class="settings-row__desc"
                >${t("devices.localSessions.pending", { owner: view.enrollment.ownerLabel })}
                ${t("devices.localSessions.pendingExpires", {
                  time: formatRelativeTimestamp(view.enrollment.expiresAtMs),
                })}</span
              >`
            : renderLastRequest(view.last)
      }
      ${
        command
          ? html`<div class="device-local-session__command">
              <code class="settings-row__value settings-row__value--mono">${command}</code>
              ${renderCopyButton(command, t("devices.localSessions.copyCommand"))}
            </div>`
          : nothing
      }
      <div class="device-local-session__actions">
        ${
          view.kind === "none"
            ? renderShareControls(deviceId, source, props, configForm)
            : renderStopSharing(view.enrollment, props)
        }
      </div>
    </div>
  `;
}

/** Sharing rows for one connected node; empty when it offers no known source. */
export function renderLocalSessionSharing(params: {
  deviceId: string;
  commands: readonly string[];
  props: LocalSessionSharingProps;
  configForm: Record<string, unknown> | null;
}): TemplateResult | typeof nothing {
  const sources = offeredLocalSessionSources(params.props.sources, params.commands);
  if (sources.length === 0) {
    return nothing;
  }
  const error =
    params.props.error?.deviceId === params.deviceId ? params.props.error.message : null;
  return html`
    <div class="device-local-sessions" role="group" aria-label=${t("devices.localSessions.title")}>
      ${error ? html`<div class="callout danger">${error}</div>` : nothing}
      ${sources.map((source) =>
        renderSource(params.deviceId, source, params.props, params.configForm),
      )}
    </div>
  `;
}
