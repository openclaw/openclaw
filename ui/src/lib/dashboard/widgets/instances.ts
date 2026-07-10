// builtin:instances — connected instances + health over `system-presence`
// (PresenceEntry[]; see ui/src/api/types.ts). Each entry is a live gateway/node
// presence row; the widget shows the host/instance, mode, and an idle-derived
// health dot. Thin re-implementation — the instances page owns its own masking
// and refresh state.

import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../../i18n/index.ts";
import { formatMs } from "../../format.ts";
import type { DashboardWidget } from "../types.ts";
import { isRecord, toFiniteNumber, widgetProps } from "./types.ts";

const DEFAULT_LIMIT = 8;
// A presence row idle beyond this window renders as degraded rather than live.
const HEALTHY_IDLE_SECONDS = 120;

export type InstanceModel = {
  id: string;
  detail: string | null;
  healthy: boolean;
  lastInputMs: number | null;
};

export type InstancesModel = {
  instances: InstanceModel[];
  total: number;
};

function instanceId(entry: Record<string, unknown>): string {
  const candidate = entry.instanceId ?? entry.host ?? entry.ip ?? entry.deviceFamily;
  return typeof candidate === "string" && candidate.trim() ? candidate : "";
}

function instanceDetail(entry: Record<string, unknown>): string | null {
  const parts = [entry.mode, entry.platform, entry.version].filter(
    (part): part is string => typeof part === "string" && part.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function mapInstances(widget: DashboardWidget, value: unknown): InstancesModel {
  const raw = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.presence)
      ? value.presence
      : isRecord(value) && Array.isArray(value.nodes)
        ? value.nodes
        : [];
  const limitProp = toFiniteNumber(widgetProps(widget).limit);
  const limit = limitProp && limitProp > 0 ? Math.trunc(limitProp) : DEFAULT_LIMIT;
  const records = raw.filter(isRecord);
  const instances = records
    .map((entry) => {
      const lastInputSeconds = toFiniteNumber(entry.lastInputSeconds);
      return {
        id: instanceId(entry),
        detail: instanceDetail(entry),
        healthy: lastInputSeconds === undefined || lastInputSeconds <= HEALTHY_IDLE_SECONDS,
        lastInputMs: lastInputSeconds !== undefined ? lastInputSeconds * 1000 : null,
      };
    })
    .filter((entry) => entry.id)
    .slice(0, limit);
  return { instances, total: records.length };
}

export function renderInstances(widget: DashboardWidget, value: unknown): TemplateResult {
  const model = mapInstances(widget, value);
  if (model.instances.length === 0) {
    return html`<div class="dashboard-widget__placeholder">
      ${t("dashboard.widget.instances.empty")}
    </div>`;
  }
  return html`
    <ul class="dashboard-list dashboard-instances" data-test-id="dashboard-instances">
      ${model.instances.map(
        (instance) => html`
          <li class="dashboard-list__row">
            <span
              class="dashboard-dot ${instance.healthy
                ? "dashboard-dot--ok"
                : "dashboard-dot--warn"}"
              aria-hidden="true"
            ></span>
            <span class="dashboard-list__label">${instance.id}</span>
            ${instance.detail
              ? html`<span class="dashboard-list__meta">${instance.detail}</span>`
              : nothing}
            ${instance.lastInputMs !== null
              ? html`<span class="dashboard-list__meta"
                  >${t("dashboard.widget.instances.idle", {
                    duration: formatMs(instance.lastInputMs),
                  })}</span
                >`
              : nothing}
          </li>
        `,
      )}
    </ul>
  `;
}
