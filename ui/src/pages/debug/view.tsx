import { createMemo, For, Show, untrack } from "solid-js";
import type { EventLogEntry } from "../../api/event-log.ts";
import type { CronStatus } from "../../api/types.ts";
import { isNativeEmbedHost } from "../../app/native-web-chrome.ts";
import { highlightJsonHtml } from "../../components/markdown-code-blocks.ts";
import { KeyboardShortcut, ShortcutText } from "../../components/solid/kbd.tsx";
import {
  SettingsPage,
  SettingsRow as Row,
  SettingsSection as Section,
  SettingsStatus as Status,
} from "../../components/solid/settings-ui.tsx";
import { formatTimeMs } from "../../lib/format.ts";
import type {
  CommandLaneDynamicSummary,
  CommandLaneSnapshot,
} from "../../lib/gateway-diagnostics.ts";
import { KEYBOARD_SHORTCUT_COMBOS } from "../../lib/keyboard-shortcut-contract.ts";
import { formatEventPayload } from "../../lib/presenter.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { sanitizedHtml } from "../../lib/solid-dom.ts";
import { CommandLaneRows } from "./lane-table.tsx";

export type DebugProps = {
  connected: boolean;
  offlineStable: boolean;
  loading: boolean;
  status: Record<string, unknown> | null;
  health: Record<string, unknown> | null;
  models: unknown[];
  automations: CronStatus | null;
  lanes: CommandLaneSnapshot[];
  dynamic: CommandLaneDynamicSummary | null;
  diagnosticsError: string | null;
  eventLog: readonly EventLogEntry[];
  methods: string[];
  callMethod: string;
  callParams: string;
  callResult: string | null;
  callError: string | null;
  onCallMethodChange: (next: string) => void;
  onCallParamsChange: (next: string) => void;
  onRefresh: () => void;
  onOpenOverlay: () => void;
  onCall: () => void;
};

function CodeBlock(props: { title: string; value: unknown; format: () => string }) {
  // The highlighter escapes source text; preserve the generated nodes until that value changes.
  const dependency = createMemo(() => props.value);
  const content = createMemo(() => {
    dependency();
    return untrack(() => highlightJsonHtml(props.format()));
  });
  return (
    <pre
      class="code-block"
      role="group"
      aria-label={props.title}
      tabindex={0}
      ref={sanitizedHtml(content)}
    />
  );
}

function SecurityRow(props: { status: DebugProps["status"] }) {
  const summary = () =>
    // SAFETY: status.get publishes numeric security-audit counters in this field.
    (props.status as { securityAudit?: { summary?: Record<string, number> } } | null)?.securityAudit
      ?.summary;
  const critical = () => summary()?.critical ?? 0;
  const warn = () => summary()?.warn ?? 0;
  const label = () => {
    const info = summary()?.info ?? 0;
    const text =
      critical() > 0
        ? t("debug.security.critical", { count: String(critical()) })
        : warn() > 0
          ? t("debug.security.warnings", { count: String(warn()) })
          : t("debug.security.noCriticalIssues");
    return text + (info > 0 ? ` · ${t("debug.security.info", { count: String(info) })}` : "");
  };
  return (
    <Show when={summary()}>
      <Row
        title={t("debug.security.audit")}
        description={
          <>
            {t("debug.security.runPrefix")} <span class="mono">openclaw security audit --deep</span>{" "}
            {t("debug.security.runSuffix")}
          </>
        }
        control={
          <>
            <Status kind={critical() > 0 ? "danger" : warn() > 0 ? "warn" : "ok"} label={label()} />
          </>
        }
      />
    </Show>
  );
}

export function DebugPageView(props: DebugProps) {
  return (
    <SettingsPage wide>
      <Section
        title={t("debug.snapshotsTitle")}
        description={t("debug.snapshotsSubtitle")}
        actions={
          <button
            class="btn"
            disabled={!props.connected || props.loading}
            onClick={() => props.onRefresh()}
          >
            {props.connected && props.loading ? t("common.refreshing") : t("common.refresh")}
          </button>
        }
      >
        <Show when={!props.connected && props.offlineStable}>
          <Row
            title={<Status kind="muted" label={t("common.offline")} />}
            description={t("debug.offlineSnapshots")}
          />
        </Show>
        <Show when={props.diagnosticsError}>
          <div class="settings-row" role="alert">
            <div class="settings-row__text">
              <span class="settings-row__title">
                <Status kind="danger" label={t("common.failed")} />
              </span>
              <span class="settings-row__desc">{props.diagnosticsError}</span>
            </div>
          </div>
        </Show>
        <SecurityRow status={props.status} />
        <Row
          title={t("debug.automations")}
          description={t("debug.automationsSubtitle")}
          control={
            <>
              {props.automations
                ? t("debug.automationsSummary", {
                    state: t(props.automations.enabled ? "common.enabled" : "common.disabled"),
                    count: String(props.automations.jobs),
                    next:
                      props.automations.nextWakeAtMs == null
                        ? t("debug.noWakeScheduled")
                        : formatTimeMs(props.automations.nextWakeAtMs),
                  })
                : t("debug.overlay.unavailable")}
            </>
          }
        />
      </Section>
      <Section title={t("debug.rawProtocolTitle")} description={t("debug.rawProtocolSubtitle")}>
        <For each={["status", "health"] as const}>
          {(key) => {
            const title = () => t(`debug.${key}`);
            return (
              <Row
                title={title()}
                stacked
                control={
                  <>
                    <CodeBlock
                      title={title()}
                      value={props[key]}
                      format={() => JSON.stringify(props[key] ?? {}, null, 2)}
                    />
                  </>
                }
              />
            );
          }}
        </For>
      </Section>
      <Section
        title={t("debug.lanes.title")}
        description={t("debug.lanes.subtitle")}
        actions={
          <button class="btn" onClick={() => props.onOpenOverlay()}>
            <Show when={!isNativeEmbedHost()} fallback={t("debug.overlay.open")}>
              <ShortcutText
                text={t("debug.overlay.openWithShortcut", { shortcut: "{shortcut}" })}
                shortcut={() => (
                  <KeyboardShortcut combo={KEYBOARD_SHORTCUT_COMBOS.debugOverlay} inline />
                )}
              />
            </Show>
          </button>
        }
      >
        <div class="data-table-container command-lanes-table-wrap">
          <table class="data-table command-lanes-table settings-table--stacked" role="table">
            <thead>
              <tr>
                <For each={["lane", "active", "queued", "group", "blocked"]}>
                  {(column) => <th scope="col">{t(`debug.lanes.${column}`)}</th>}
                </For>
              </tr>
            </thead>
            <tbody>
              <CommandLaneRows lanes={props.lanes} dynamic={props.dynamic} />
            </tbody>
          </table>
        </div>
      </Section>
      <Section title={t("debug.manualRpcTitle")} description={t("debug.manualRpcSubtitle")}>
        <Row
          title={t("debug.method")}
          control={
            <>
              <select
                class="settings-select"
                aria-label={t("debug.method")}
                value={props.callMethod}
                onChange={(event) => props.onCallMethodChange(event.currentTarget.value)}
              >
                <Show when={!props.callMethod}>
                  <option value="" disabled>
                    {t("debug.selectMethod")}
                  </option>
                </Show>
                <For each={props.methods}>
                  {(method) => <option value={method}>{method}</option>}
                </For>
              </select>
            </>
          }
        />
        <Row
          title={t("debug.paramsJson")}
          stacked
          control={
            <>
              <textarea
                class="settings-input"
                aria-label={t("debug.paramsJson")}
                value={props.callParams}
                onInput={(event) => props.onCallParamsChange(event.currentTarget.value)}
                rows={6}
              />
            </>
          }
        />
        <Row
          title={t("common.call")}
          control={
            <>
              <button class="btn primary" onClick={() => props.onCall()}>
                {t("common.call")}
              </button>
            </>
          }
        />
        <Show when={props.callError}>
          <div class="settings-row settings-row--stacked" role="alert">
            <Status kind="danger" label={t("debug.callFailed")} />
            <pre class="code-block" role="group" aria-label={t("debug.callFailed")} tabindex={0}>
              {props.callError}
            </pre>
          </div>
        </Show>
        <Show when={props.callResult}>
          <div class="settings-row settings-row--stacked">
            <Status kind="ok" label={t("common.ok")} />
            <CodeBlock
              title={`${props.callMethod}: ${t("common.ok")}`}
              value={props.callResult}
              format={() => props.callResult ?? ""}
            />
          </div>
        </Show>
      </Section>
      <Section title={t("debug.modelsTitle")} description={t("debug.modelsSubtitle")}>
        <div class="settings-row settings-row--stacked">
          <CodeBlock
            title={t("debug.modelsTitle")}
            value={props.models}
            format={() => JSON.stringify(props.models, null, 2)}
          />
        </div>
      </Section>
      <Section title={t("debug.eventLogTitle")} description={t("debug.eventLogSubtitle")}>
        <For
          each={props.eventLog}
          fallback={<div class="settings-empty">{t("debug.noEvents")}</div>}
        >
          {(event) => (
            <Row
              title={event.event}
              description={formatTimeMs(event.ts, undefined, "")}
              stacked
              control={
                <>
                  <CodeBlock
                    title={event.event}
                    value={event.payload}
                    format={() => formatEventPayload(event.payload)}
                  />
                </>
              }
            />
          )}
        </For>
      </Section>
    </SettingsPage>
  );
}
