import { For, Loading, Show, createMemo, createSignal, onCleanup } from "solid-js";
import type { SessionSystemPromptReport } from "../../../../../src/config/sessions/session-system-prompt-report.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { formatCompactTokenCount } from "../../../lib/format.ts";
import { projectGateway } from "../../../lib/reactive/application.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  areUiSessionKeysEquivalent,
  scopedSessionArtifactKey,
} from "../../../lib/sessions/session-key.ts";
import { requestSessionUsage } from "../../../lib/sessions/usage.ts";
import {
  buildChatContextCategories,
  type ContextCategory,
} from "./chat-context-breakdown-model.ts";
import "../../../styles/chat/context-breakdown.css";

const labelKeys = {
  messages: "contextMessages",
  files: "contextFiles",
  tools: "contextTools",
  skills: "contextSkills",
  system: "contextSystem",
} as const;

function ContextRow(props: { category: ContextCategory; limit: number }) {
  const tokens = () => props.category.tokens;
  const value = () => (tokens() === null ? "—" : "~" + formatCompactTokenCount(tokens()!));
  const percent = () =>
    tokens() === null ? "—" : "~" + ((tokens()! / props.limit) * 100).toFixed(1) + "%";
  const label = () => t("chat.sessionDetails." + labelKeys[props.category.id]);
  const content = () => (
    <>
      <span class={"chat-context__swatch chat-context__" + props.category.id} aria-hidden="true" />
      <span class="chat-context__label">
        <span>{label()}</span>
        <Show when={props.category.entries.length > 0}>
          <small>{props.category.entries.length}</small>
        </Show>
      </span>
      <span class="chat-context__tokens">{value()}</span>
      <span class="chat-context__percent">{percent()}</span>
    </>
  );
  return (
    <Show
      when={props.category.entries.length > 0}
      fallback={
        <div class="chat-context__row" data-context-category={props.category.id}>
          {content()}
        </div>
      }
    >
      <details class="chat-context__details" data-context-details={props.category.id}>
        <summary class="chat-context__row" data-context-category={props.category.id}>
          {content()}
          <Icon name="chevronDown" />
        </summary>
        <div class="chat-context__entries">
          <For each={props.category.entries} keyed={(entry) => entry.name}>
            {(entry) => (
              <div class="chat-context__entry">
                <span title={entry().name}>{entry().name}</span>
                <span>
                  {entry().tokens === null
                    ? t("chat.sessionDetails.contextUnverified")
                    : "~" + formatCompactTokenCount(entry().tokens!)}
                </span>
              </div>
            )}
          </For>
        </div>
      </details>
    </Show>
  );
}

export function ChatContextBreakdown(props: {
  gateway: ApplicationGateway;
  session: GatewaySessionRow;
  agentId?: string;
  used: number;
  limit: number;
  approximate?: boolean;
}) {
  const gateway = createMemo(() => projectGateway(props.gateway));
  const [revision, setRevision] = createSignal(0);
  const target = createMemo(
    () => {
      const connection = gateway().read();
      return {
        client: connection.snapshot.phase === "connected" ? connection.snapshot.client : null,
        connectionRevision: connection.connectionRevision,
        key: scopedSessionArtifactKey(props.session.key, props.agentId),
        sessionId: props.session.sessionId,
        model: props.session.activeModel || props.session.model,
        provider: props.session.modelProvider,
        revision: revision(),
        used: props.used,
      };
    },
    {
      equals: (a, b) =>
        a.client === b.client &&
        a.connectionRevision === b.connectionRevision &&
        a.key === b.key &&
        a.sessionId === b.sessionId &&
        a.model === b.model &&
        a.provider === b.provider &&
        a.revision === b.revision &&
        a.used === b.used,
    },
  );
  const result = createMemo(
    async (): Promise<{
      report: SessionSystemPromptReport | null;
      failed?: boolean;
      offline?: boolean;
    }> => {
      const current = target();
      if (!current.client) {
        return { report: null, offline: true };
      }
      const controller = new AbortController();
      onCleanup(() => controller.abort());
      try {
        // Context reports are independent of the usage date range. Keep this
        // existing single-session read bounded to today's usage, not its history.
        const today = new Date().toISOString().slice(0, 10);
        const response = await requestSessionUsage(
          current.client,
          {
            startDate: today,
            endDate: today,
            timeZone: "utc",
            scope: "instance",
            agentId: props.agentId,
          },
          { key: current.key, includeContextWeight: true, signal: controller.signal },
        );
        const row = response.sessions.find((entry) =>
          areUiSessionKeysEquivalent(entry.key, current.key),
        );
        const report = row?.contextWeight;
        if (
          !report ||
          (current.sessionId &&
            (row?.sessionId !== current.sessionId ||
              (report.sessionId && report.sessionId !== current.sessionId))) ||
          (report.model && current.model && report.model !== current.model) ||
          (report.provider && current.provider && report.provider !== current.provider)
        ) {
          return { report: null };
        }
        return { report };
      } catch {
        return { report: null, failed: true };
      }
    },
  );
  return (
    <div class="chat-context">
      <Loading
        on={target()}
        fallback={
          <p class="chat-context__note" role="status">
            {t("chat.sessionDetails.contextLoading")}
          </p>
        }
      >
        <Show
          when={result().report}
          fallback={
            <p class="chat-context__note" role="status">
              {t(
                result().offline
                  ? "chat.sessionDetails.contextOffline"
                  : result().failed
                    ? "chat.sessionDetails.contextError"
                    : "chat.sessionDetails.contextUnavailable",
              )}
            </p>
          }
        >
          {(report) => {
            const categories = createMemo(() => buildChatContextCategories(report(), props.used));
            return (
              <>
                <div class="chat-context__bar" aria-hidden="true">
                  <For each={categories()} keyed={(category) => category.id}>
                    {(category) => (
                      <span
                        class={"chat-context__segment chat-context__" + category().id}
                        style={{
                          width:
                            Math.min(100, ((category().tokens ?? 0) / props.limit) * 100) + "%",
                        }}
                      />
                    )}
                  </For>
                </div>
                <div class="chat-context__legend">
                  <For each={categories()} keyed={(category) => category.id}>
                    {(category) => <ContextRow category={category()} limit={props.limit} />}
                  </For>
                  <div class="chat-context__row" data-context-category="free">
                    <span class="chat-context__swatch chat-context__free" aria-hidden="true" />
                    <span class="chat-context__label">{t("chat.sessionDetails.contextFree")}</span>
                    <span class="chat-context__tokens">
                      {props.approximate ? "~" : ""}
                      {formatCompactTokenCount(Math.max(0, props.limit - props.used))}
                    </span>
                    <span class="chat-context__percent">
                      {props.approximate ? "~" : ""}
                      {((Math.max(0, props.limit - props.used) / props.limit) * 100).toFixed(1)}%
                    </span>
                  </div>
                </div>
                <p class="chat-context__note">{t("chat.sessionDetails.contextEstimate")}</p>
              </>
            );
          }}
        </Show>
      </Loading>
      <button
        type="button"
        class="chat-context__refresh"
        onClick={() => setRevision((value) => value + 1)}
      >
        <Icon name="refresh" />
        {t("common.refresh")}
      </button>
    </div>
  );
}
