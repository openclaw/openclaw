// This client-only card uses the signals export to keep its deferred runtime lazy.
import { createDeferred } from "@solidjs/signals";
import { createMemo, createSignal, isPending, Loading, onSettled, Show } from "solid-js";
import type { ClawHubRecommendation } from "../../../../../src/shared/clawhub-recommendations.js";
import { hasOperatorAdminAccess, hasOperatorReadAccess } from "../../../app/operator-access.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { WizardLogin } from "../../../components/wizard-login-controller.tsx";
import { registerPluginManagementEnglish } from "../../../i18n/locales/en-plugin-management.ts";
import { createGatewayConnectionLifecycle } from "../../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod } from "../../../lib/gateway-methods.ts";
import { resolveSafeExternalUrl } from "../../../lib/open-external-url.ts";
import {
  loadPluginDiscoveryDetail,
  type PluginsInspectResult,
} from "../../../lib/plugins/index.ts";
import { useApplication } from "../../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { ClawHubSkillDetail } from "../../../lib/skills/index.ts";
import { loadSkillStatusReport } from "../../../lib/skills/status-report.ts";
import { pluginInstallOperations } from "../../plugins/install-progress.ts";
import { PluginIconOwner, pluginIconFetchContext } from "../../plugins/plugin-icon-owner.ts";
import { createPluginMcpLogin } from "../../plugins/plugin-mcp-login.ts";
import { resolvePluginCatalogIconUrl } from "../../plugins/presentation.ts";
import { subscribeClawHubCardUpdates } from "./chat-clawhub-card-updates.ts";
import type { ChatClawHubCardProps } from "./chat-clawhub-card.tsx";

registerEnglishCatalog(registerPluginManagementEnglish);

type CardPresentation = Pick<
  ClawHubRecommendation,
  "id" | "kind" | "name" | "description" | "iconUrl"
> & {
  registry?: string;
  pluginId?: string;
  author?: string;
  official: boolean;
  inspection?: PluginsInspectResult;
};
type CardStatus = CardPresentation & {
  installed: boolean;
  canInstall: boolean;
  restricted: boolean;
  disabled: boolean;
  connection?: "connected" | "connecting" | "sign-in";
};
type StatusRead =
  | { status: "empty" }
  | { status: "ready"; result: CardStatus }
  | { status: "failed"; error: unknown };

/** Catalog owners authorize status; icon controllers own their object URLs through disposal. */
export function ChatClawHubCardBody(
  props: ChatClawHubCardProps & { onOpenListing: (install?: boolean) => void },
) {
  const context = useApplication();
  let active = true;
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const notify = () => active && setRevision((value) => value + 1);
  const [statusRequest, setStatusRequest] = createSignal<Promise<StatusRead>>();
  // Admission stays synchronous; the deferred read lets existing artwork remain visible.
  const status = createDeferred<StatusRead>(() => statusRequest() ?? { status: "empty" });
  const statusPending = () => status().status === "empty" || isPending(() => status());
  const readyStatus = () => {
    const current = status();
    return !statusPending() && current.status === "ready" ? current.result : undefined;
  };
  const readFailed = () => !statusPending() && status().status === "failed";
  const state: {
    iconUrls: Record<string, string>;
    pluginIconUrls: Record<string, string>;
    loadedImage?: string;
    failedImages: Set<string>;
    presentation?: CardPresentation;
  } = {
    iconUrls: {},
    pluginIconUrls: {},
    loadedImage: undefined,
    failedImages: new Set<string>(),
    presentation: undefined,
  };
  const read = () => {
    revision();
    return state;
  };
  let generation = 0;
  let controller: AbortController | undefined;
  let previousArgs: unknown[] = [];
  const connection = createGatewayConnectionLifecycle({ client: null, phase: "stopped" });
  const installations = pluginInstallOperations(context.gateway);
  const mcpLogin = createPluginMcpLogin(
    {
      get client() {
        return context.gateway.snapshot.client;
      },
      get snapshot() {
        return context.gateway.snapshot;
      },
      capture: () => connection.capture(),
      isCurrent: (scope) => connection.isCurrent(scope),
    },
    {
      getDetail: () => {
        const current = state.presentation;
        return current?.pluginId && current.inspection
          ? { pluginId: current.pluginId, inspection: current.inspection }
          : null;
      },
      getName: () => state.presentation?.name,
      refresh: async () => {
        load(true);
      },
      // Sign-out remains on the Manage page; this card only starts authorization.
      setMessage: () => {},
    },
  );
  const createIcons = (catalog: boolean) =>
    new PluginIconOwner({
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
      mcpLogin.reset();
      pluginIcons.reset();
    }
    state.presentation = card;
    if (card.pluginId) {
      pluginIcons.load(card.pluginId);
    }
    catalogIcons.syncCatalog([], card.iconUrl ? [card.iconUrl] : []);
    notify();
  }
  function load(force = false) {
    const snapshot = context.gateway.snapshot;
    if (connection.transition(snapshot)) {
      mcpLogin.reset();
      resetIcons();
    }
    const card = props.recommendation;
    const agentId = props.agentId;
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
    if (!scope || !card) {
      setStatusRequest(undefined);
      notify();
      return;
    }
    const client = scope.client;
    controller = new AbortController();
    const signal = controller.signal;
    const current = () => active && generation === requestGeneration && connection.isCurrent(scope);
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
    void setStatusRequest(
      (async (): Promise<StatusRead> => {
        try {
          const result = await (async (): Promise<CardStatus> => {
            if (card.kind === "plugin") {
              if (!hasOperatorReadAccess(snapshot.hello?.auth ?? null)) {
                return {
                  ...card,
                  installed: false,
                  canInstall: false,
                  restricted: true,
                  disabled: false,
                };
              }
              const { plugin } = await loadPluginDiscoveryDetail(client, card.id, signal);
              signal.throwIfAborted();
              const pluginId = plugin.local.installed ? plugin.local.pluginId : undefined;
              // The plugin page owns sign-in; only offer it where that page can start it.
              const inspection =
                pluginId && canCallGatewayMethod(snapshot, "mcp.authLogin", "operator.admin")
                  ? await client.request<PluginsInspectResult>(
                      "plugins.inspect",
                      { pluginId },
                      { signal },
                    )
                  : undefined;
              signal.throwIfAborted();
              return {
                ...card,
                name: plugin.catalog.name,
                author: plugin.catalog.author,
                description: plugin.catalog.summary,
                iconUrl: plugin.catalog.imageUrl,
                pluginId: plugin.local.pluginId,
                official: plugin.catalog.official,
                inspection,
                installed: plugin.local.installed,
                canInstall:
                  plugin.local.action === "install" &&
                  hasOperatorAdminAccess(snapshot.hello?.auth ?? null),
                restricted: !hasOperatorAdminAccess(snapshot.hello?.auth ?? null),
                disabled: plugin.local.installed && plugin.local.state === "disabled",
                // These are configured MCP server connections, not universal plugin accounts.
                connection: inspection?.mcpAuth?.length
                  ? inspection.mcpAuth.some((server) => server.state === "pending-authorization")
                    ? "connecting"
                    : inspection.mcpAuth.some((server) => server.state !== "authorized")
                      ? "sign-in"
                      : "connected"
                  : undefined,
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
              restricted: false,
              disabled: false,
            };
          })();
          if (!current()) {
            return { status: "empty" };
          }
          if (result.installed) {
            installations.reconcileInstalled(result.id, result.pluginId);
          }
          if (result.iconUrl && !state.iconUrls[result.iconUrl]) {
            catalogIcons.invalidate(result.iconUrl);
          }
          presentCard(result);
          return { status: "ready", result };
        } catch (error) {
          return current() ? { status: "failed", error } : { status: "empty" };
        }
      })(),
    );
  }
  function onInstallProgress(event: { identity?: string; settled: boolean }) {
    if (
      !event.identity ||
      event.identity === "install:" + state.presentation?.id ||
      event.identity === "plugin:" + state.presentation?.pluginId
    ) {
      notify();
      if (event.settled) {
        load(true);
      }
    }
  }
  onSettled(() => {
    // Connection edges retire request generations and icon URLs before later replies arrive.
    const stop = subscribeClawHubCardUpdates(context.gateway, document, load);
    const stopInstallations = installations.subscribe(onInstallProgress);
    return () => {
      active = false;
      ++generation;
      controller?.abort();
      stop();
      stopInstallations();
      connection.dispose();
      resetIcons();
    };
  });
  const card = (): CardPresentation | undefined => read().presentation ?? props.recommendation;
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
  const iconPending = () => {
    const currentState = read();
    const current = card();
    return icon()
      ? currentState.loadedImage !== icon()
      : Boolean(current?.pluginId && pluginIcons.isLoading(current.pluginId)) ||
          Boolean(current?.iconUrl && catalogIcons.isLoading(current.iconUrl)) ||
          (statusPending() && !current?.pluginId && !current?.iconUrl);
  };
  const installProgress = () => {
    read();
    return (
      installations.progress.get("install:" + props.recommendation?.id) ??
      installations.progress.get("plugin:" + card()?.pluginId)
    );
  };
  const installing = () =>
    Boolean(installProgress() && installProgress()?.finishedAt === undefined);
  const authState = () => mcpLogin.dialog.state();
  const authorizing = () => authState().phase === "starting" || authState().phase === "step";
  const authFailure = () =>
    Boolean(card()?.inspection?.mcpAuth?.some((entry) => entry.state !== "authorized")) &&
    (Boolean(mcpLogin.outcome()) || authState().phase === "error");
  const authorizationUrl = () => {
    const current = authState();
    return current.phase === "step" && current.step.externalUrl
      ? resolveSafeExternalUrl(current.step.externalUrl, window.location.href)
      : undefined;
  };
  const interactiveAuth = () => {
    const current = authState();
    return current.phase === "step" && !(current.step.type === "note" && current.step.externalUrl);
  };
  const connect = () => {
    const server = card()?.inspection?.mcpAuth?.find((entry) => entry.state !== "authorized");
    if (server) {
      void (authFailure() ? mcpLogin.retry(server.serverName) : mcpLogin.start(server.serverName));
    }
  };
  const statusLabel = () => {
    if (installing()) {
      return t("chat.clawhub.installing");
    }
    if (installProgress()?.failure) {
      return installProgress()?.canRetry
        ? t("chat.clawhub.installFailed")
        : installProgress()?.failure?.title;
    }
    if (authorizing()) {
      return t("chat.clawhub.connecting");
    }
    if (authFailure()) {
      return t(
        mcpLogin.outcome() === "cancelled"
          ? "chat.clawhub.connectionCancelled"
          : mcpLogin.outcome() === "expired"
            ? "chat.clawhub.connectionExpired"
            : "chat.clawhub.connectionFailed",
      );
    }
    const result = readyStatus();
    if (!result) {
      return t("chat.clawhub.statusUnavailable");
    }
    if (!result.installed) {
      return result.canInstall
        ? ""
        : t(result.restricted ? "chat.clawhub.permissionRequired" : "chat.clawhub.unavailable");
    }
    return t(
      result.disabled
        ? "chat.clawhub.disabled"
        : result.connection === "connecting"
          ? "chat.clawhub.connecting"
          : result.connection === "sign-in"
            ? "chat.clawhub.signInNeeded"
            : result.connection === "connected"
              ? "chat.clawhub.connected"
              : "pluginsPage.installed",
    );
  };
  const primaryLabel = () => {
    if (installing()) {
      return t("chat.clawhub.installing");
    }
    if (authorizing()) {
      return t("common.cancel");
    }
    if (authFailure()) {
      return t("common.retry");
    }
    const progress = installProgress();
    if (progress?.failure) {
      return t(progress.canRetry ? "common.retry" : "chat.clawhub.manage");
    }
    if (readFailed() || !online()) {
      return t("common.retry");
    }
    const result = readyStatus();
    return result?.installed
      ? t(
          result.connection === "sign-in" && !result.disabled
            ? "chat.clawhub.connect"
            : "chat.clawhub.manage",
        )
      : result?.canInstall
        ? t("pluginsPage.install")
        : undefined;
  };
  const runPrimary = () => {
    if (installing()) {
      return;
    }
    if (authorizing()) {
      mcpLogin.dialog.viewProps().onCancel?.();
      return;
    }
    if (authFailure()) {
      connect();
      return;
    }
    const progress = installProgress();
    if (progress?.failure) {
      props.onOpenListing(progress.canRetry === true);
      return;
    }
    if (readFailed() || !online()) {
      if (!online()) {
        context.gateway.connect();
      }
      load(true);
      return;
    }
    const result = readyStatus();
    if (result?.installed && result.connection === "sign-in" && !result.disabled) {
      connect();
    } else {
      props.onOpenListing(!result?.installed && result?.canInstall === true);
    }
  };
  const online = () => {
    read();
    return context.gateway.snapshot.phase === "connected";
  };
  const statusSkeleton = (
    <span class="chat-clawhub-card__status-skeleton">
      <Show when={online()}>
        <span class="btn__spinner" aria-hidden="true" />
      </Show>
      <span>{t(online() ? "chat.clawhub.checking" : "chat.clawhub.statusUnavailable")}</span>
    </span>
  );
  return (
    <>
      <Show when={[props.recommendation, props.agentId]} keyed>
        {(_input) => {
          onSettled(() => {
            load();
          });
          return null;
        }}
      </Show>
      <Show when={props.recommendation && card()}>
        {(current) => (
          <div
            class="card chat-clawhub-card"
            data-clawhub-id={current().id}
            aria-busy={
              statusPending() || iconPending() || installing() || authorizing() ? "true" : "false"
            }
          >
            <button
              class="chat-clawhub-card__listing"
              type="button"
              onClick={() => props.onOpenListing()}
            >
              <span
                class={["chat-clawhub-card__icon muted", { skeleton: iconPending() }]}
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
                        state.failedImages.add(src);
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
                      <span class="plugin-card-author muted">@{author().replace(/^@+/, "")}</span>
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
                <span class="chat-clawhub-card__status muted" aria-live="polite">
                  <Loading fallback={statusSkeleton}>
                    <Show
                      when={
                        statusPending() &&
                        !installing() &&
                        !authorizing() &&
                        !authFailure() &&
                        !installProgress()?.failure
                      }
                      fallback={
                        <span
                          class={[
                            "chat-clawhub-card__status-content",
                            { "chat-clawhub-card__installed": readyStatus()?.installed },
                          ]}
                        >
                          <Show
                            when={
                              (installing() ||
                                authorizing() ||
                                readyStatus()?.connection === "connecting") &&
                              !readyStatus()?.disabled
                            }
                          >
                            <span class="btn__spinner" aria-hidden="true" />
                          </Show>
                          <Show
                            when={
                              readyStatus()?.installed &&
                              !installing() &&
                              !authorizing() &&
                              !authFailure() &&
                              !installProgress()?.failure &&
                              !readyStatus()?.disabled &&
                              (!readyStatus()?.connection ||
                                readyStatus()?.connection === "connected")
                            }
                          >
                            <Icon name="check" style={{ width: "16px", height: "16px" }} />
                          </Show>
                          <span>{statusLabel()}</span>
                        </span>
                      }
                    >
                      {statusSkeleton}
                    </Show>
                  </Loading>
                </span>
              </span>
            </button>
            <div class="chat-clawhub-card__actions">
              <Show when={!authorizing()}>
                <button
                  type="button"
                  class="btn chat-clawhub-card__details"
                  onClick={() => props.onOpenListing()}
                >
                  {t("chat.clawhub.details")}
                </button>
              </Show>
              <Show when={authorizing() && authorizationUrl()}>
                {(url) => (
                  <a
                    class="btn chat-clawhub-card__reopen"
                    href={url()}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t("chat.clawhub.reopenAuthorization")}
                  </a>
                )}
              </Show>
              <Loading>
                <Show when={primaryLabel()}>
                  {(label) => (
                    <button
                      type="button"
                      class={[
                        "btn primary",
                        {
                          "chat-clawhub-card__install":
                            !installing() &&
                            !installProgress()?.failure &&
                            readyStatus()?.canInstall,
                          "chat-clawhub-card__installing": installing(),
                          "chat-clawhub-card__sign-in":
                            readyStatus()?.connection === "sign-in" && !readyStatus()?.disabled,
                          "chat-clawhub-card__retry":
                            readFailed() ||
                            !online() ||
                            authFailure() ||
                            Boolean(
                              installProgress()?.failure?.title && installProgress()?.canRetry,
                            ),
                          "chat-clawhub-card__manage":
                            readyStatus()?.installed && readyStatus()?.connection !== "sign-in",
                        },
                      ]}
                      disabled={installing() || (authorizing() && mcpLogin.dialog.cancelling)}
                      onClick={runPrimary}
                    >
                      {label()}
                    </button>
                  )}
                </Show>
              </Loading>
            </div>
          </div>
        )}
      </Show>
      <Show when={authorizing() && !interactiveAuth()}>
        {mcpLogin.dialog.viewProps().cancellationFeedback}
      </Show>
      <Show when={interactiveAuth()}>
        <WizardLogin controller={mcpLogin.dialog} />
      </Show>
    </>
  );
}
