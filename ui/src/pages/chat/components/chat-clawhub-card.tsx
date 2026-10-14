import { createEffect, createMemo, createSignal, onCleanup, untrack, Show } from "solid-js";
import type { ClawHubRecommendation } from "../../../../../src/shared/clawhub-recommendations.js";
import { pathForPluginCatalogEntry } from "../../../app-route-paths.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerPluginManagementEnglish } from "../../../i18n/locales/en-plugin-management.ts";
import { createGatewayConnectionLifecycle } from "../../../lib/gateway-connection-lifecycle.ts";
import { loadPluginDiscoveryDetail } from "../../../lib/plugins/index.ts";
import { useApplication } from "../../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { ClawHubSkillDetail } from "../../../lib/skills/index.ts";
import { loadSkillStatusReport } from "../../../lib/skills/status-report.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";
import {
  PluginIconController,
  pluginIconFetchContext,
} from "../../plugins/plugin-icon-controller.ts";
import { resolvePluginCatalogIconUrl } from "../../plugins/presentation.ts";
import "../../../styles/chat/clawhub-card.css";

registerEnglishCatalog(registerPluginManagementEnglish);

type CardPresentation = Pick<
  ClawHubRecommendation,
  "id" | "kind" | "name" | "description" | "iconUrl"
> & {
  registry?: string;
  pluginId?: string;
  author?: string;
  official: boolean;
};
type CardStatus = CardPresentation & { installed: boolean; canInstall: boolean };
type Props = { recommendation?: ClawHubRecommendation; agentId?: string };

/** Catalog owners authorize status; icon controllers own their object URLs through disposal. */
function ChatClawHubCardContent(props: Props, host: SolidBridgeElement<Props>) {
  const context = useApplication();
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const notify = () => setRevision((value) => value + 1);
  const state: {
    dismissed: boolean;
    iconUrls: Record<string, string>;
    pluginIconUrls: Record<string, string>;
    loadedImage?: string;
    failedImages: Set<string>;
    presentation?: CardPresentation;
    result?: CardStatus;
    status: "initial" | "pending" | "ready" | "error";
  } = {
    dismissed: false,
    iconUrls: {},
    pluginIconUrls: {},
    loadedImage: undefined,
    failedImages: new Set<string>(),
    presentation: undefined,
    result: undefined,
    status: "initial",
  };
  const read = () => {
    revision();
    return state;
  };
  let active = true;
  let generation = 0;
  let controller: AbortController | undefined;
  let previousArgs: unknown[] = [];
  const connection = createGatewayConnectionLifecycle({ client: null, phase: "stopped" });
  const createIcons = (catalog: boolean) =>
    new PluginIconController({
      kind: catalog ? "catalog" : undefined,
      getFetchContext: () => pluginIconFetchContext(context),
      isConnected: () => active && context.gateway.snapshot.phase === "connected",
      onUrlsChange: (urls) => {
        if (catalog) {
          state.iconUrls = urls;
        } else {
          state.pluginIconUrls = urls;
        }
        notify();
      },
      onLoadingChange: notify,
    });
  const catalogIcons = createIcons(true);
  const pluginIcons = createIcons(false);
  function resetIcons() {
    catalogIcons.reset();
    pluginIcons.reset();
    state.loadedImage = undefined;
    state.failedImages = new Set();
    state.presentation = undefined;
  }
  function presentCard(card: CardPresentation) {
    if (card.pluginId !== state.presentation?.pluginId) {
      pluginIcons.reset();
    }
    state.presentation = card;
    if (card.pluginId) {
      pluginIcons.load(card.pluginId);
    }
    catalogIcons.syncCatalog([], card.iconUrl ? [card.iconUrl] : []);
    notify();
  }
  async function load(force = false) {
    const snapshot = context.gateway.snapshot;
    if (connection.transition(snapshot)) {
      resetIcons();
    }
    const card = host.recommendation;
    const agentId = host.agentId;
    const scope = connection.capture();
    const args = [
      scope?.client,
      agentId,
      connection.epoch,
      card?.kind === "plugin" ? snapshot.pluginCapabilities?.generation : undefined,
      card?.id,
      card?.kind,
      card?.kind === "skill" ? card.registry : undefined,
    ];
    if (!force && args.every((arg, index) => arg === previousArgs[index])) {
      return;
    }
    previousArgs = args;
    controller?.abort();
    const requestGeneration = ++generation;
    state.result = undefined;
    state.status = "initial";
    if (!scope || !card) {
      notify();
      return;
    }
    const client = scope.client;
    controller = new AbortController();
    const signal = controller.signal;
    const current = () =>
      active &&
      generation === requestGeneration &&
      connection.isCurrent(scope) &&
      host.recommendation?.id === card.id &&
      host.recommendation?.kind === card.kind &&
      host.agentId === agentId &&
      (card.kind !== "skill" ||
        (host.recommendation.kind === "skill" && host.recommendation.registry === card.registry));
    const previous = state.presentation;
    if (
      !previous ||
      previous.id !== card.id ||
      previous.kind !== card.kind ||
      (previous.kind === "skill" && card.kind === "skill" && previous.registry !== card.registry)
    ) {
      resetIcons();
      presentCard(card);
    }
    state.status = "pending";
    notify();
    try {
      const result = await (async (): Promise<CardStatus> => {
        if (card.kind === "plugin") {
          const { plugin } = await loadPluginDiscoveryDetail(client, card.id, signal);
          signal.throwIfAborted();
          return {
            ...card,
            name: plugin.catalog.name,
            author: plugin.catalog.author,
            description: plugin.catalog.summary,
            iconUrl: plugin.catalog.imageUrl,
            pluginId: plugin.local.pluginId,
            official: plugin.catalog.official,
            installed: plugin.local.installed,
            canInstall: plugin.catalog.official && plugin.local.action === "install",
          };
        }
        if (!agentId) {
          throw new Error("Skill recommendations require an agent.");
        }
        const [detail, report] = await Promise.all([
          client.request<ClawHubSkillDetail>("skills.detail", { slug: card.id }, { signal }),
          loadSkillStatusReport(client, agentId),
        ]);
        signal.throwIfAborted();
        if (!detail.skill || !report) {
          throw new Error("Skill details are unavailable.");
        }
        const installed = report.skills.some(
          ({ clawhub }) =>
            clawhub?.status === "linked" &&
            clawhub.valid &&
            !clawhub.requestedReference &&
            clawhub.registry === card.registry &&
            `@${clawhub.ownerHandle}/${clawhub.slug}` === card.id,
        );
        return {
          ...card,
          name: detail.skill.displayName,
          author: detail.owner?.handle ?? undefined,
          pluginId: undefined,
          description: detail.skill.summary ?? undefined,
          official: detail.skill.isOfficial === true,
          installed,
          canInstall: detail.skill.isOfficial === true && !installed,
        };
      })();
      if (!current()) {
        return;
      }
      if (result.iconUrl && !state.iconUrls[result.iconUrl]) {
        catalogIcons.invalidate(result.iconUrl);
      }
      presentCard(result);
      state.result = result;
      state.status = "ready";
    } catch {
      if (current()) {
        state.status = "error";
      }
    } finally {
      if (current()) {
        notify();
      }
    }
  }
  createEffect(
    () => [
      props.recommendation?.id,
      props.recommendation?.kind,
      props.recommendation?.kind === "skill" ? props.recommendation.registry : undefined,
      props.agentId,
    ],
    () => {
      void load();
    },
  );
  const stop = context.gateway.subscribe(() =>
    untrack(() => {
      void load();
    }),
  );
  const activate = () => {
    if (context.gateway.snapshot.phase === "connected" && document.visibilityState === "visible") {
      void load(true);
    }
  };
  document.addEventListener("visibilitychange", activate);
  globalThis.addEventListener("focus", activate);
  onCleanup(() => {
    active = false;
    ++generation;
    controller?.abort();
    stop();
    connection.dispose();
    resetIcons();
    document.removeEventListener("visibilitychange", activate);
    globalThis.removeEventListener("focus", activate);
  });
  function openListing(install = false) {
    const card = host.recommendation;
    if (!card) {
      return;
    }
    if (card.kind === "plugin") {
      context.navigate("plugins", {
        pathname: pathForPluginCatalogEntry(card.id, context.basePath),
        search: install ? "?action=install" : "",
      });
    } else {
      const search = new URLSearchParams({ clawhub: card.id });
      if (host.agentId) {
        search.set("agent", host.agentId);
      }
      context.navigate("skills", { search: `?${search}` });
    }
  }
  const card = createMemo(
    (): CardPresentation | undefined => read().presentation ?? props.recommendation,
  );
  const icon = createMemo(() => {
    const current = card();
    return current
      ? resolvePluginCatalogIconUrl(
          { pluginId: current.pluginId, imageUrl: current.iconUrl },
          { pluginIconUrls: read().pluginIconUrls, iconUrls: read().iconUrls },
          read().failedImages,
        )
      : undefined;
  });
  const iconPending = createMemo(() => {
    const currentState = read();
    const current = card();
    return icon()
      ? currentState.loadedImage !== icon()
      : Boolean(current?.pluginId && pluginIcons.isLoading(current.pluginId)) ||
          Boolean(current?.iconUrl && catalogIcons.isLoading(current.iconUrl)) ||
          (currentState.status !== "ready" &&
            currentState.status !== "error" &&
            !current?.pluginId &&
            !current?.iconUrl);
  });
  return (
    <Show when={props.recommendation && !read().dismissed && card()}>
      {(current) => (
        <div
          class="card chat-clawhub-card"
          data-clawhub-id={current().id}
          aria-busy={
            read().status === "pending" || read().status === "initial" || iconPending()
              ? "true"
              : "false"
          }
        >
          <button class="chat-clawhub-card__listing" type="button" onClick={() => openListing()}>
            <span
              class={["chat-clawhub-card__icon", { skeleton: iconPending() }]}
              aria-hidden="true"
            >
              <Show
                when={icon()}
                keyed
                fallback={
                  <Show when={!iconPending()}>
                    <Icon name="plug" />
                  </Show>
                }
              >
                {(src) => (
                  <img
                    src={src}
                    alt=""
                    hidden={iconPending()}
                    onLoad={() => {
                      state.loadedImage = src;
                      notify();
                    }}
                    onError={() => {
                      state.failedImages = new Set([...state.failedImages, src]);
                      notify();
                    }}
                  />
                )}
              </Show>
            </span>
            <span class="chat-clawhub-card__identity">
              <span class="card-title chat-clawhub-card__name">
                <span>{current().name}</span>{" "}
                <Show when={current().author}>
                  {(author) => (
                    <span class="plugin-card-author">@{author().replace(/^@+/, "")}</span>
                  )}
                </Show>
                <Show when={current().official}>
                  <span
                    class="plugin-official-badge"
                    role="img"
                    aria-label={t("pluginsPage.official")}
                    title={t("pluginsPage.official")}
                  >
                    <Icon name="badgeCheck" />
                  </span>
                </Show>
              </span>
              <Show when={current().description}>
                {(description) => <span class="card-sub">{description()}</span>}
              </Show>
            </span>
          </button>
          <div class="chat-clawhub-card__actions" aria-live="polite">
            <Show
              when={read().status === "ready"}
              fallback={
                <Show
                  when={read().status === "error"}
                  fallback={
                    <>
                      <span
                        class="skeleton chat-clawhub-card__status-skeleton"
                        aria-hidden="true"
                      />
                      <span class="sr-only">{t("common.loading")}</span>
                    </>
                  }
                >
                  <button
                    type="button"
                    class="btn chat-clawhub-card__dismiss"
                    onClick={() => {
                      void load(true);
                    }}
                  >
                    {t("chat.clawhub.retryStatus")}
                  </button>
                </Show>
              }
            >
              <Show
                when={read().result?.installed}
                fallback={
                  <>
                    <button
                      type="button"
                      class="btn chat-clawhub-card__dismiss"
                      onClick={() => {
                        state.dismissed = true;
                        notify();
                      }}
                    >
                      {t("common.dismiss")}
                    </button>
                    <button
                      type="button"
                      class="btn primary chat-clawhub-card__install"
                      onClick={() => openListing(read().result?.canInstall === true)}
                    >
                      {read().result?.canInstall
                        ? t("pluginsPage.install")
                        : t("chat.clawhub.viewDetails")}
                    </button>
                  </>
                }
              >
                <span class="chip chip-ok chat-clawhub-card__installed">
                  <Icon name="check" />
                  <span>{t("pluginsPage.installed")}</span>
                </span>
              </Show>
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}

export const ChatClawHubCard = defineSolidBridge<Props>(
  "openclaw-chat-clawhub-card",
  ChatClawHubCardContent,
  {
    properties: {
      recommendation: { default: undefined, attribute: false },
      agentId: { default: undefined, attribute: false },
    },
  },
);
