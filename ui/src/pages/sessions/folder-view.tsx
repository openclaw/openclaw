import { createMemo, createSignal, For, Show } from "solid-js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { serializeSidebarEntry } from "../../app-navigation.ts";
import { togglePinnedSession } from "../../app/bootstrap-navigation-preferences.ts";
import { SessionProgressCard } from "../../components/session-progress-card-solid.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { renderNewSessionLink as NewSessionLink } from "../../components/solid/new-session-link.tsx";
import { SettingsStatus } from "../../components/solid/settings-ui.tsx";
import { registerSessionFoldersEnglish } from "../../i18n/locales/en-session-folders.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { handleNavigationClick } from "../../lib/navigation-click.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectProgressCard } from "../../lib/reactive/domain-keyed.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { sessionProgressCardsForGateway } from "../../lib/session-progress-cards.ts";
import { isSessionRunStateActive } from "../../lib/session-run-state.ts";
import {
  openPreferredApplicationSession,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { isPinnableUiSessionRow } from "../../lib/sessions/session-key.ts";
import type { SessionsProps } from "./view-types.ts";
import "./folder-view.css";

registerSessionFoldersEnglish();

function ThreadLink(props: {
  row: GatewaySessionRow;
  children?: import("@solidjs/web").JSX.Element;
}) {
  const context = useApplication();
  const target = () =>
    sessionNavigationTarget({ context, face: "chat", sessionKey: props.row.key });
  return (
    <a
      href={target().href}
      onClick={(event) =>
        handleNavigationClick(event, () => openPreferredApplicationSession(context, props.row.key))
      }
    >
      {props.children ?? resolveSessionDisplayName(props.row.key, props.row)}
    </a>
  );
}

function SavedBrief(props: { row: GatewaySessionRow }) {
  const context = useApplication();
  const store = sessionProgressCardsForGateway(context.gateway);
  const progress = projectProgressCard(() => ({ store, target: { sessionKey: props.row.key } }));
  return (
    <section class="folder-brief">
      <div class="folder-eyebrow">{t("sessionFolders.savedBrief")}</div>
      <h3>
        <ThreadLink row={props.row} />
      </h3>
      <p class="muted">{t("sessionFolders.briefSource")}</p>
      <Show
        when={progress.read().card}
        fallback={
          <p class="folder-empty">
            {progress.read().loading
              ? t("common.loading")
              : progress.read().error
                ? t("sessionFolders.briefUnavailable")
                : t("sessionFolders.noBrief")}
          </p>
        }
      >
        {(card) => <SessionProgressCard card={card()} placement="board" />}
      </Show>
      <ThreadLink row={props.row}>{t("sessionFolders.continueThread")} →</ThreadLink>
    </section>
  );
}

function ThreadCard(props: { row: GatewaySessionRow; view: SessionsProps; pinned: boolean }) {
  const context = useApplication();
  const active = () => isSessionRunStateActive(props.row);
  return (
    <article class="folder-thread" data-folder-thread={props.row.key}>
      <div class="folder-thread__top">
        <Icon name="messageSquare" />
        <ThreadLink row={props.row} />
        <SettingsStatus
          kind={active() ? "running" : props.row.status === "failed" ? "danger" : "muted"}
          label={active() ? t("sessionFolders.running") : t("sessionFolders.idle")}
        />
      </div>
      <Show when={props.row.lastAssistantMessage?.text ?? props.row.lastMessagePreview}>
        {(preview) => <p class="folder-thread__preview">{preview()}</p>}
      </Show>
      <div class="folder-thread__footer">
        <span>{formatRelativeTimestamp(props.row.updatedAt ?? 0)}</span>
        <button
          type="button"
          class="btn btn--xs btn--ghost"
          disabled={!isPinnableUiSessionRow(props.row)}
          onClick={() => togglePinnedSession(context.navigation, props.row.key)}
        >
          <Icon name="pin" />
          {props.pinned ? t("sessionFolders.unpin") : t("sessionFolders.pin")}
        </button>
        <select
          class="settings-select"
          aria-label={t("sessionFolders.moveThread", {
            name: resolveSessionDisplayName(props.row.key, props.row),
          })}
          value={props.row.category ?? ""}
          disabled={props.view.loading || Boolean(props.view.groupWriteDisabledReason)}
          title={props.view.groupWriteDisabledReason}
          onChange={(event) => {
            void props.view.onAssignCategory(props.row.key, event.currentTarget.value || null);
          }}
        >
          <option value="">{t("sessionsView.ungrouped")}</option>
          <For each={props.view.knownCategories}>
            {(name) => <option value={name}>{name}</option>}
          </For>
        </select>
      </div>
    </article>
  );
}

export function SessionFolderView(props: {
  view: SessionsProps;
  folder: string;
  onOpen(folder: string): void;
}) {
  const context = useApplication();
  const navigation = projectOwner(context.navigation, (owner) => owner.snapshot);
  const isPinned = (row: GatewaySessionRow) =>
    navigation
      .read()
      .sidebarEntries.includes(serializeSidebarEntry({ type: "session", key: row.key }));
  const newThreadAccess = () =>
    readSessionMethodAccess(context.gateway.snapshot, {
      method: "sessions.create",
      params: {},
      sessionScope: true,
    });
  const [tab, setTab] = createSignal<"overview" | "threads" | "context">("overview");
  const rows = createMemo(() => props.view.result?.sessions ?? []);
  const members = createMemo(() =>
    rows()
      .filter((row) => row.category === props.folder)
      .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
  );
  const pinned = createMemo(() => members().filter(isPinned));
  const briefing = createMemo(() => pinned()[0]);
  const running = createMemo(() => members().filter(isSessionRunStateActive).length);
  return (
    <div class="session-folders">
      <Show
        when={props.folder}
        fallback={
          <>
            <div class="folder-title-row">
              <div>
                <h2>{t("sessionFolders.title")}</h2>
                <p class="muted">{t("sessionFolders.description")}</p>
              </div>
              <button
                type="button"
                class="btn primary"
                disabled={Boolean(props.view.groupWriteDisabledReason)}
                onClick={() => props.view.onRequestNewCategory()}
              >
                <Icon name="plus" />
                {t("sessionFolders.newFolder")}
              </button>
            </div>
            <div class="folder-grid">
              <For each={props.view.knownCategories}>
                {(name) => (
                  <button type="button" class="folder-tile" onClick={() => props.onOpen(name)}>
                    <Icon name="folder" />
                    <h3>{name}</h3>
                    <span class="muted">
                      {t("sessionFolders.threadCount", {
                        count: String(rows().filter((row) => row.category === name).length),
                      })}
                    </span>
                    <span class="folder-tile__arrow">→</span>
                  </button>
                )}
              </For>
            </div>
            <Show when={!props.view.knownCategories.length}>
              <p class="folder-empty">{t("sessionFolders.noFolders")}</p>
            </Show>
          </>
        }
      >
        <button class="btn btn--sm btn--ghost" onClick={() => props.onOpen("")}>
          ← {t("sessionFolders.title")}
        </button>
        <div class="folder-title-row">
          <div>
            <div class="folder-eyebrow">
              <Icon name="folder" />
              {t("sessionFolders.projectFolder")}
            </div>
            <h2>{props.folder}</h2>
            <p class="muted">{t("sessionFolders.accessUnchanged")}</p>
          </div>
          <NewSessionLink
            basePath={context.basePath}
            agentId={props.view.agentId}
            target={{ group: props.folder }}
            class="btn primary"
            label={t("sessionFolders.newThread")}
            showLabel
            disabledReason={(() => {
              const access = newThreadAccess();
              return access.allowed ? undefined : access.reason;
            })()}
          />
        </div>
        <div class="folder-metrics">
          <div>
            <strong>{members().length}</strong>
            <span>{t("sessionFolders.threads")}</span>
          </div>
          <div>
            <strong>{running()}</strong>
            <span>{t("sessionFolders.running")}</span>
          </div>
          <div>
            <strong>{pinned().length}</strong>
            <span>{t("sessionFolders.pinned")}</span>
          </div>
          <p>{t("sessionFolders.statusCaveat")}</p>
        </div>
        <div class="folder-tabs" role="tablist" aria-label={t("sessionFolders.title")}>
          <For each={["overview", "threads", "context"] as const}>
            {(name) => (
              <button
                role="tab"
                aria-selected={tab() === name ? "true" : "false"}
                class={["btn btn--sm", { primary: tab() === name }]}
                onClick={() => setTab(name)}
              >
                {t("sessionFolders." + name)}
              </button>
            )}
          </For>
        </div>
        <Show
          when={tab() !== "context"}
          fallback={
            <section class="folder-context">
              <h3>{t("sessionFolders.context")}</h3>
              <p class="muted">{t("sessionFolders.contextDescription")}</p>
              <For each={pinned()}>{(row) => <SavedBrief row={row} />}</For>
              <Show when={!pinned().length}>
                <p class="folder-empty">{t("sessionFolders.pinHint")}</p>
              </Show>
              <h3>{t("sessionFolders.artifacts")}</h3>
              <p class="muted">{t("sessionFolders.artifactDescription")}</p>
              <For each={members()}>
                {(row) => (
                  <div class="folder-artifact-source">
                    <Icon name="folder" />
                    <ThreadLink row={row} />
                    <span class="muted">{t("sessionFolders.sourceThread")}</span>
                  </div>
                )}
              </For>
            </section>
          }
        >
          <div class={["folder-layout", { "folder-layout--threads": tab() === "threads" }]}>
            <section>
              <div class="folder-section-title">
                <h3>{t("sessionFolders.threads")}</h3>
                <span class="muted">{t("sessionFolders.moveHint")}</span>
              </div>
              <div class="folder-thread-list">
                <For each={members()}>
                  {(row) => <ThreadCard row={row} view={props.view} pinned={isPinned(row)} />}
                </For>
              </div>
              <Show when={!members().length}>
                <p class="folder-empty">{t("sessionFolders.empty")}</p>
              </Show>
            </section>
            <Show when={tab() === "overview"}>
              <aside>
                <Show
                  when={briefing()}
                  fallback={
                    <section class="folder-brief">
                      <h3>{t("sessionFolders.savedBrief")}</h3>
                      <p class="muted">{t("sessionFolders.pinHint")}</p>
                    </section>
                  }
                >
                  {(row) => <SavedBrief row={row()} />}
                </Show>
                <div class="folder-callout">
                  <Icon name="layers" />
                  <div>
                    <strong>{t("sessionFolders.coordinator")}</strong>
                    <p>{t("sessionFolders.coordinatorHint")}</p>
                  </div>
                </div>
              </aside>
            </Show>
          </div>
        </Show>
      </Show>
      <p class="folder-coverage">
        {t("sessionFolders.coverage")}
        {props.view.result?.hasMore ? (
          <button class="btn btn--sm btn--ghost" onClick={() => props.view.onLoadMore()}>
            {t("chat.selectors.loadMoreRosterSessions")}
          </button>
        ) : null}
      </p>
    </div>
  );
}
