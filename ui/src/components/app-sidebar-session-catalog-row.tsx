import type { JSX } from "@solidjs/web";
import { createMemo, createEffect, Show } from "solid-js";
import type {
  SessionCatalog,
  SessionCatalogHost,
  SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.ts";
import { normalizeSessionColorValue } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import type { GatewaySessionRow } from "../api/types.ts";
import { handleContextMenuEvent } from "../lib/keyboard-shortcuts.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { t } from "../lib/reactive/i18n.ts";
import type { CatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import { buildCatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { renderHoverMarquee } from "../lib/solid/hover-marquee.tsx";
import {
  formatSidebarTimestamp,
  normalizeCatalogTimestamp,
  type CatalogSessionMenuRequest,
} from "./app-sidebar-session-catalogs.ts";
import type { SessionCatalogGroupsParams } from "./app-sidebar-session-render-types.ts";
import { Icon } from "./solid/icon.tsx";
import {
  SessionGlyph,
  SessionRowBadges,
  sessionRunVisibility,
} from "./solid/session-presentation.tsx";
const CATALOG_CONTROL_SELECTORS = [
  ".sidebar-recent-session__link",
  "[data-child-session-toggle]",
  "[data-sidebar-session-pin]",
  "[data-sidebar-session-archive]",
  "[data-sidebar-session-menu]",
  "[data-catalog-session-menu]",
] as const;
function catalogRowRef(
  identityKey: string,
  sessionKey: string,
  catalogKey: CatalogSessionKey,
  menuOpen: boolean,
  params: SessionCatalogGroupsParams,
): ((element: Element | undefined) => void) | undefined {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const activeRow = active?.closest<HTMLElement>("[data-session-key]");
  const selector = CATALOG_CONTROL_SELECTORS.find((candidate) => active?.matches(candidate));
  const restoreFocus =
    selector !== undefined &&
    (activeRow?.dataset.catalogSessionKey === identityKey ||
      activeRow?.dataset.sessionKey === identityKey ||
      activeRow?.dataset.sessionKey === sessionKey);
  if (!menuOpen && !restoreFocus) {
    return undefined;
  }
  return (element) => {
    if (!(element instanceof HTMLElement)) {
      return;
    }
    if (menuOpen) {
      params.onCatalogMenuTriggerRendered(
        catalogKey,
        element.querySelector("[data-catalog-session-menu]") ??
          element.querySelector(".sidebar-recent-session__link") ??
          undefined,
      );
    }
    if (restoreFocus) {
      queueMicrotask(() => {
        if (element.isConnected && document.activeElement === document.body) {
          (
            element.querySelector<HTMLElement>(selector) ??
            element.querySelector<HTMLElement>(".sidebar-recent-session__link")
          )?.focus({
            preventScroll: true,
          });
        }
      });
    }
  };
}
export function renderCatalogSessionRow(
  readCatalog: () => SessionCatalog,
  readHost: () => SessionCatalogHost,
  readSession: () => SessionCatalogSession,
  readLiveRowsByKey: () => ReadonlyMap<string, GatewaySessionRow>,
  params: SessionCatalogGroupsParams,
  projectChild = false,
) {
  const timestamp = createMemo(() =>
    normalizeCatalogTimestamp(
      readSession().recencyAt ?? readSession().updatedAt ?? readSession().createdAt,
    ),
  );
  const catalogKey = createMemo(() => {
    const readCatalogValue = readCatalog();
    const readHostValue = readHost();
    const readSessionValue = readSession();
    return {
      catalogId: readCatalogValue.id,
      hostId: readHostValue.hostId,
      threadId: readSessionValue.threadId,
      ...(readSessionValue.sourceHomeId
        ? {
            sourceHomeId: readSessionValue.sourceHomeId,
          }
        : {}),
    } satisfies CatalogSessionKey;
  });
  const identityKey = createMemo(() => buildCatalogSessionKey(catalogKey()));
  const key = createMemo(
    () =>
      readSession().sessionKey ?? buildCatalogSessionKey(catalogKey(), params.newSessionAgentId),
  );
  const label = createMemo(() => readSession().name || readSession().threadId);
  const meta = createMemo(() => formatSidebarTimestamp(timestamp()));
  const routeId = "chat";
  const target = createMemo(() =>
    sessionNavigationTarget({
      face: routeId,
      sessionKey: key(),
      fallbackAgentId: params.newSessionAgentId,
      basePath: params.basePath,
      mainKey: params.mainKey,
    }),
  );
  const href = createMemo(() => target().href),
    navigation = createMemo(() => target().options);
  const catalogMenu = createMemo<CatalogSessionMenuRequest>(() => ({
    key: catalogKey(),
    agentId: params.newSessionAgentId,
    routeId,
    navigation: navigation(),
    canOpenTerminal: readSession().canOpenTerminal === true,
    canDelete: readSession().canArchive && readCatalog().capabilities.archive,
    name: readSession().name ?? readSession().threadId,
    displayName: readSession().name,
    meta: meta(),
  }));
  const menuOpen = createMemo(() => params.isMenuOpen(catalogKey()));
  const adoptedRow = createMemo(() => {
    const readSessionValue = readSession();
    const readLiveRowsByKeyValue = readLiveRowsByKey();
    return readSessionValue.sessionKey
      ? readLiveRowsByKeyValue.get(readSessionValue.sessionKey)
      : undefined;
  });
  const rowRef = createMemo(() => {
    // Adoption swaps the rendered row even when the catalog key is unchanged.
    adoptedRow();
    return catalogRowRef(identityKey(), key(), catalogKey(), menuOpen(), params);
  });
  const color = createMemo(() => normalizeSessionColorValue(readSession().color ?? ""));
  const active = createMemo(() => key() === params.routeSessionKey);
  const running = createMemo(
    () => readSession().status === "active" || readSession().status === "running",
  );
  const canOpenTerminal = createMemo(
    () => readSession().canOpenTerminal === true && params.terminalAvailable,
  );
  const openTerminal = () => params.onOpenTerminal(catalogKey(), params.newSessionAgentId);
  const openMenu = (x: number, y: number, trigger?: HTMLElement) =>
    params.onOpenMenu(catalogMenu(), x, y, trigger);
  const openMenuFromEvent: JSX.EventHandler<HTMLDivElement, MouseEvent | KeyboardEvent> = (event) =>
    handleContextMenuEvent(
      event,
      event instanceof KeyboardEvent
        ? event.currentTarget.querySelector<HTMLElement>("[data-catalog-session-menu]")
        : null,
      (trigger, x, y) => openMenu(x, y, trigger ?? undefined),
    );
  const marqueeLabel = (
    <Show when={JSON.stringify([label(), readSession().status, readSession().pullRequest])} keyed>
      {(_identity) => renderHoverMarquee(label(), "sidebar-recent-session__name")}
    </Show>
  );
  let element: HTMLDivElement | undefined;
  createEffect(
    () => rowRef(),
    (callback) => callback?.(element),
  );
  const row = (
    <div
      ref={(node) => {
        element = node;
      }}
      class={`sidebar-recent-session session-row-host sidebar-recent-session--single-line ${color() ? "sidebar-recent-session--colored" : ""} ${active() ? "sidebar-recent-session--active" : ""} ${projectChild ? "sidebar-recent-session--catalog-project-child" : ""} ${running() ? "session-row-host--running" : ""}`}
      style={color() ? `--session-color: var(--session-color-${color()})` : undefined}
      data-session-key={key()}
      data-catalog-session-key={identityKey()}
      data-session-row-action-count="1"
      role="listitem"
      onContextMenu={openMenuFromEvent}
      onKeyDown={openMenuFromEvent}
    >
      <a
        href={href()}
        class="sidebar-recent-session__link"
        aria-current={active() ? "page" : undefined}
        onClick={(event: MouseEvent) => {
          if (!shouldHandleNavigationClick(event)) {
            return;
          }
          event.preventDefault();
          if (params.catalogOpenTarget === "terminal" && canOpenTerminal()) {
            openTerminal();
          } else {
            params.onNavigate?.(routeId, navigation());
          }
        }}
      >
        <span class="sidebar-session-indicator">
          {running() ? (
            <SessionGlyph
              content={undefined}
              running={running()}
              runVisibility={sessionRunVisibility()}
            />
          ) : undefined}
        </span>
        <span class="sidebar-recent-session__text">
          <span class="sidebar-recent-session__title-row"> {marqueeLabel} </span>
          <span class="sidebar-recent-session__details">
            <span class="sidebar-recent-session__details-endcap">
              {<SessionRowBadges pullRequest={readSession().pullRequest} />}
            </span>
          </span>
        </span>
      </a>
      <span class="sidebar-recent-session__aside session-row-aside">
        <span class="session-row-actions">
          <button
            class="session-action"
            data-catalog-session-menu="true"
            type="button"
            title={t("chat.sidebar.openSessionMenu")}
            aria-label={t("chat.sidebar.openSessionMenu")}
            aria-haspopup="menu"
            aria-expanded={menuOpen() ? "true" : "false"}
            onClick={(event) => {
              event.stopPropagation();
              const trigger = event.currentTarget;
              const rect = trigger.getBoundingClientRect();
              openMenu(rect.right, rect.bottom + 4, trigger);
            }}
          >
            <Icon name="moreHorizontal" />
          </button>
        </span>
      </span>
    </div>
  );
  return (
    <Show when={adoptedRow()} fallback={row}>
      {(liveRow) =>
        params.renderLiveRow(liveRow, {
          get catalogIdentityKey() {
            return identityKey();
          },
          get catalogMenu() {
            return catalogMenu();
          },
          get rowRef() {
            return rowRef();
          },
          get pullRequest() {
            return readSession().pullRequest;
          },
        })
      }
    </Show>
  );
}
