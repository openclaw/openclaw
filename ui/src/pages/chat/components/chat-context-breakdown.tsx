import { For, Show, createMemo, onSettled, type Element } from "solid-js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatDetailsEnglish } from "../../../i18n/locales/en-chat-details.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { formatCompactTokenCount } from "../../../lib/format.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import { sessionContextReportsForGateway } from "../../../lib/session-context-report.ts";
import { showToast } from "../../../lib/toast.ts";
import {
  buildChatContextCategories,
  buildDeferredContextGroups,
  type ContextEntry,
  type ContextGroup,
  type ContextCategory,
} from "./chat-context-breakdown-model.ts";
import "../../../styles/chat/context-breakdown.css";

registerEnglishCatalog(registerChatSessionEnglish);
registerEnglishCatalog(registerChatDetailsEnglish);

const labelKeys = {
  messages: "contextMessages",
  files: "contextFiles",
  tools: "contextTools",
  skills: "contextSkills",
  system: "contextSystem",
} as const;

const groupLabelKeys = {
  "agent-workspace": "contextAgentWorkspace",
  "execution-project": "contextProject",
  personal: "contextPersonal",
  other: "contextOtherFiles",
  openclaw: "contextSystemTools",
  mcp: "contextMcpTools",
  client: "contextClientTools",
  "unknown-tools": "contextTools",
} as const;

function ContextEntries(props: { entries: ContextEntry[] }) {
  return (
    <For each={props.entries} keyed={(entry) => entry.key}>
      {(entry) => (
        <div class="chat-context__entry">
          <span title={entry().path ?? entry().name}>
            <span>{entry().name}</span>
            <Show when={entry().path}>
              <small class="chat-context__path">{entry().path}</small>
            </Show>
          </span>
          <span>
            {entry().tokens === null
              ? t("chat.sessionDetails.contextUnverified")
              : "~" + formatCompactTokenCount(entry().tokens!)}
          </span>
        </div>
      )}
    </For>
  );
}

function ContextGroups(props: { groups: ContextGroup[] }) {
  return (
    <For each={props.groups} keyed={(group) => group.key}>
      {(group) => (
        <section class="chat-context__source" data-context-source={group().kind}>
          <div class="chat-context__source-heading">
            <span title={group().path}>
              {t("chat.sessionDetails." + groupLabelKeys[group().kind])}
              <Show when={group().name}> · {group().name}</Show>
            </span>
            <small>
              {group().entries.length} ·{" "}
              {group().tokens === null ? "—" : "~" + formatCompactTokenCount(group().tokens!)}
            </small>
          </div>
          <ContextEntries entries={group().entries} />
        </section>
      )}
    </For>
  );
}

function ContextRow(props: { category: ContextCategory; compact?: boolean }) {
  const content = () => (
    <>
      <span
        class={["chat-context__swatch", `chat-context__${props.category.id}`]}
        aria-hidden="true"
      />
      <span class="chat-context__label">
        {t("chat.sessionDetails." + labelKeys[props.category.id])}
        <Show when={!props.compact && props.category.entries.length > 0}>
          <small> {props.category.entries.length}</small>
        </Show>
      </span>
      <span class="chat-context__tokens">
        {props.category.tokens === null
          ? props.compact
            ? t("chat.sessionDetails.contextUnverified")
            : "—"
          : "~" + formatCompactTokenCount(props.category.tokens)}
      </span>
    </>
  );
  return (
    <div class="chat-context__row" data-context-category={props.category.id}>
      {content()}
    </div>
  );
}

function ContextSections(props: { categories: ContextCategory[] }) {
  return (
    <For
      each={props.categories.filter((category) => category.entries.length > 0)}
      keyed={(category) => category.id}
    >
      {(category) => (
        <section class="chat-context__section" data-context-section={category().id}>
          <h3>{t("chat.sessionDetails." + labelKeys[category().id])}</h3>
          <div class="chat-context__entries">
            <Show
              when={category().groups}
              fallback={<ContextEntries entries={category().entries} />}
            >
              {(groups) => <ContextGroups groups={groups()} />}
            </Show>
          </div>
        </section>
      )}
    </For>
  );
}

function ContextActions(props: { onRefresh: () => void }) {
  return (
    <div class="chat-context__actions">
      <button
        type="button"
        class="chat-context__refresh"
        aria-label={t("common.refresh")}
        title={t("common.refresh")}
        onClick={() => props.onRefresh()}
      >
        <Icon name="refresh" />
        {t("common.refresh")}
      </button>
    </div>
  );
}

export function ChatContextBreakdown(props: {
  gateway: ApplicationGateway;
  session: GatewaySessionRow;
  agentId?: string;
  used: number;
  limit: number;
  approximate?: boolean;
  presented?: boolean;
  expanded?: boolean;
  popover?: boolean;
  loadingFallback?: Element;
  children?: Element;
}) {
  const binding = createMemo(
    () => ({
      gateway: props.gateway,
      sessionKey: props.session.key,
      agentId: props.agentId,
      sessionId: props.session.sessionId,
      model: props.session.activeModel || props.session.model,
      provider: props.session.modelProvider,
    }),
    {
      equals: (a, b) =>
        a.gateway === b.gateway &&
        a.sessionKey === b.sessionKey &&
        a.agentId === b.agentId &&
        a.sessionId === b.sessionId &&
        a.model === b.model &&
        a.provider === b.provider,
    },
  );
  return (
    <Show when={binding()} keyed>
      {(identity) => {
        const owner = {};
        const reports = sessionContextReportsForGateway(identity.gateway);
        const target = () => ({ ...identity, used: props.used });
        const view = projectOwner(reports, (store) => store.get(target()));
        const result = view.read;
        let retained = true;
        onSettled(() => () => {
          retained = false;
          reports.unwatch(owner);
        });
        const demand = createMemo(() => (props.presented !== false ? target() : undefined), {
          equals: (previous, next) => previous?.used === next?.used,
        });
        const refresh = async () => {
          const outcome = await reports.refresh(target());
          if (
            retained &&
            props.presented !== false &&
            (outcome === "failed" || outcome === "offline")
          ) {
            showToast({
              message: t(
                outcome === "offline"
                  ? "chat.sessionDetails.contextOffline"
                  : "chat.sessionDetails.contextError",
              ),
              icon: "alertTriangle",
            });
          }
        };
        return (
          <>
            <Show when={demand()} keyed>
              {(current) => {
                onSettled(() => {
                  reports.watch(owner, current);
                  return () => {
                    if (retained) {
                      reports.watch(owner, current, false);
                    }
                  };
                });
                return null;
              }}
            </Show>
            <div
              class={[
                "chat-context",
                {
                  "chat-context--expanded": props.expanded,
                  "chat-context--popover": props.popover,
                },
              ]}
            >
              <Show when={props.expanded}>
                <ContextActions onRefresh={() => void refresh()} />
              </Show>
              <Show
                when={!result().loading || result().report}
                fallback={
                  props.popover ? (
                    props.loadingFallback
                  ) : (
                    <>
                      <p class="chat-context__note" role="status">
                        {t("chat.sessionDetails.contextLoading")}
                      </p>
                      {props.children}
                    </>
                  )
                }
              >
                <Show
                  when={result().report}
                  fallback={
                    <>
                      <p class="chat-context__note" role="status">
                        {t(
                          result().offline
                            ? "chat.sessionDetails.contextOffline"
                            : result().failed
                              ? "chat.sessionDetails.contextError"
                              : "chat.sessionDetails.contextUnavailable",
                        )}
                      </p>
                      {props.children}
                    </>
                  }
                >
                  {(report) => {
                    const categories = createMemo(() =>
                      buildChatContextCategories(report(), props.used),
                    );
                    const deferred = createMemo(() => buildDeferredContextGroups(report()));
                    return (
                      <>
                        <div class="chat-context__bar" aria-hidden="true">
                          <For each={categories()} keyed={(category) => category.id}>
                            {(category) => (
                              <span
                                class={["chat-context__segment", `chat-context__${category().id}`]}
                                style={{
                                  width:
                                    Math.min(100, ((category().tokens ?? 0) / props.limit) * 100) +
                                    "%",
                                }}
                              />
                            )}
                          </For>
                        </div>
                        <div class="chat-context__legend">
                          <For each={categories()} keyed={(category) => category.id}>
                            {(category) => (
                              <ContextRow category={category()} compact={props.popover} />
                            )}
                          </For>
                          <Show when={props.expanded}>
                            <div class="chat-context__row" data-context-category="free">
                              <span
                                class="chat-context__swatch chat-context__free"
                                aria-hidden="true"
                              />
                              <span class="chat-context__label">
                                {t("chat.sessionDetails.contextFree")}
                              </span>
                              <span class="chat-context__tokens">
                                {props.approximate ? "~" : ""}
                                {formatCompactTokenCount(Math.max(0, props.limit - props.used))}
                              </span>
                            </div>
                          </Show>
                        </div>
                        {props.children}
                        <Show when={props.expanded}>
                          <ContextSections categories={categories()} />
                        </Show>
                        <Show when={props.expanded && deferred().length > 0}>
                          <details
                            class="chat-context__details chat-context__deferred"
                            data-context-details="deferred"
                          >
                            <summary class="chat-context__source-heading">
                              <span>{t("chat.sessionDetails.contextAvailableOnDemand")}</span>
                              <small>
                                {deferred().reduce((sum, group) => sum + group.entries.length, 0)}
                              </small>
                              <Icon name="chevronDown" />
                            </summary>
                            <p class="chat-context__note">
                              {t("chat.sessionDetails.contextDeferredEstimate")}
                            </p>
                            <div class="chat-context__entries">
                              <ContextGroups groups={deferred()} />
                            </div>
                          </details>
                        </Show>
                      </>
                    );
                  }}
                </Show>
              </Show>
              <Show when={!props.expanded && !props.popover}>
                <ContextActions onRefresh={() => void refresh()} />
              </Show>
            </div>
          </>
        );
      }}
    </Show>
  );
}
