import type { PortalSummary } from "@openclaw/gateway-protocol";
import type { JSX } from "@solidjs/web";
import {
  Errored,
  For,
  Loading,
  Show,
  action,
  affects,
  createMemo,
  createOptimistic,
  createUniqueId,
  latest,
  onCleanup,
  onSettled,
} from "solid-js";
import type { PortalPanelToggleDetail } from "../../components/panel-toggle-contract.ts";
import { HubPageHeader } from "../../components/solid/hub-page-header.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { Menu } from "../../components/solid/menu.tsx";
import { PanelEmptyState } from "../../components/solid/panel-empty-state.tsx";
import { registerPortalsEnglish } from "../../i18n/locales/en-portals.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { showToast } from "../../lib/toast.ts";
import { createPortals, type PortalsModel, type PortalsPresentation } from "./portals-state.ts";
import "../../styles/session-panel-rail.css";
import "./portals.css";

registerEnglishCatalog(registerPortalsEnglish);
const PORTAL_FRAME_SANDBOX =
  "allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts";
export type PortalsPageProps = PortalsPresentation & { mobile?: boolean };

type PortalsPageMethods = { handleToggleRequest(event: Event): void };
type PortalsPageElement = SolidBridgeElement<PortalsPageProps, PortalsPageMethods>;
const owners = new WeakMap<HTMLElement, PortalsModel>();

function PortalsPageContent(props: PortalsPageProps, host: PortalsPageElement) {
  const model = createPortals(useApplication(), () => host);
  owners.set(host, model);
  onCleanup(() => owners.delete(host));
  return (
    <Show when={model.state().previewEpoch} keyed>
      {(_previewEpoch) => <PortalContent model={model} mobile={props.mobile} />}
    </Show>
  );
}

function EmptyState(props: { model: PortalsModel; mobile?: boolean }) {
  const state = () => props.model.state();
  return (
    <Show
      when={
        props.model.presentation().embedded &&
        state().loaded &&
        state().portalListSupported &&
        !state().error &&
        (!state().connected || state().canReadPortalState) &&
        (!props.mobile || !props.model.presentation().requestedPortalId)
      }
      fallback={
        <section class="portals-empty" role="status" aria-live="polite">
          <Show
            when={state().connected && !state().canReadPortalState}
            fallback={
              <>
                <Show
                  when={!state().loaded && !state().connected}
                  fallback={
                    <>
                      <div class="portals-empty__title">
                        {t(
                          props.model.presentation().requestedPortalId
                            ? "portalsPage.unavailable"
                            : "portalsPage.emptyHint",
                        )}
                      </div>
                      <Show when={!props.model.presentation().requestedPortalId}>
                        <div class="portals-empty__prompts">
                          <span>{t("portalsPage.promptShow")}</span>
                          <span>{t("portalsPage.promptStart")}</span>
                          <span>{t("portalsPage.promptMakeAvailable")}</span>
                        </div>
                      </Show>
                    </>
                  }
                >
                  <div class="portals-empty__title">{t("portalsPage.loading")}</div>
                </Show>
                <Show when={!state().portalListSupported}>
                  <div class="portals-empty__note">{t("portalsPage.unsupported")}</div>
                </Show>
                <Show when={state().error}>
                  <div class="callout danger">{state().error}</div>
                </Show>
              </>
            }
          >
            <div class="portals-empty__note">
              {t("sessionsView.actionRequiresScope", { scope: "operator.read" })}
            </div>
          </Show>
        </section>
      }
    >
      <PanelEmptyState
        presentation={props.mobile ? "mobile" : "desktop"}
        icon={<Icon name="panelsTopLeft" />}
        heading={t(
          props.model.presentation().requestedPortalId
            ? "portalsPage.embeddedUnavailableTitle"
            : "portalsPage.embeddedEmptyTitle",
        )}
        description={t(
          props.model.presentation().requestedPortalId
            ? "portalsPage.embeddedUnavailableBody"
            : "portalsPage.embeddedEmptyBody",
        )}
      />
    </Show>
  );
}

function PortalPreview(props: {
  model: PortalsModel;
  portal: PortalSummary;
  mobile?: boolean;
  closing: string | null;
  closePortal: (portal: PortalSummary) => void;
}) {
  const state = () => props.model.state();
  const embedded = () => props.model.presentation().embedded;
  const desktop = () => embedded() && !props.mobile;
  const menuId = createUniqueId();
  const identityLabels: HTMLElement[] = [];
  onSettled(() => {
    if (identityLabels.length === 0) {
      return undefined;
    }
    const update = () => {
      for (const label of identityLabels) {
        label.toggleAttribute("data-overflow", label.scrollWidth > label.clientWidth);
      }
    };
    const observer = new ResizeObserver(update);
    for (const label of identityLabels) {
      observer.observe(label);
      if (label.firstElementChild) {
        observer.observe(label.firstElementChild);
      }
    }
    update();
    return () => observer.disconnect();
  });
  const portalUrl = () => props.portal.url ?? "";
  const origin = () => new URL(props.portal.publicUrl).origin;
  const canLaunch = () => Boolean(props.portal.tokenQuery && portalUrl());
  const displayUrl = () => {
    if (!portalUrl()) {
      return "";
    }
    const value = new URL(portalUrl());
    value.search = "";
    return value.href;
  };
  const frameKey = () => `${props.portal.id}\u0000${portalUrl()}`;
  const probeStatus = () =>
    state().portalProbeState?.key === frameKey() ? state().portalProbeState!.status : "probing";
  const noticeKey = () =>
    probeStatus() === "new-tab-required"
      ? "newTabRequired"
      : probeStatus() === "ingress-required"
        ? "ingressRequired"
        : "unreachable";
  const needsNotice = () =>
    ["unreachable", "ingress-required", "new-tab-required"].includes(probeStatus());
  const embeddedNoticeKey = () =>
    probeStatus() === "new-tab-required"
      ? "embeddedNewTabRequired"
      : probeStatus() === "ingress-required"
        ? "embeddedIngressRequired"
        : "embeddedUnreachable";
  return (
    <section class="portals-preview">
      <Show when={embedded()}>
        <header
          class="session-panel-rail portals-embedded__header"
          data-presentation={props.mobile ? "mobile" : "desktop"}
        >
          <span class="portals-embedded__mark">
            <Icon name="panelsTopLeft" />
          </span>
          <div class="session-panel-rail__identity portals-embedded__identity">
            <span
              class="portals-embedded__name"
              title={props.portal.title}
              ref={(node) => identityLabels.push(node)}
            >
              <span>{props.portal.title}</span>
            </span>
            <span
              class="portals-embedded__origin"
              title={origin()}
              ref={(node) => identityLabels.push(node)}
            >
              <span>{origin()}</span>
            </span>
          </div>
          <div class="session-panel-rail__group">
            <Show when={!props.mobile}>
              <button
                class="session-panel-rail__button portals-embedded__action"
                type="button"
                title={t("portalsPage.embeddedRefresh")}
                aria-label={t("portalsPage.embeddedRefresh")}
                disabled={!canLaunch() || probeStatus() === "probing"}
                onClick={() => props.model.ensurePortalProbe(props.portal, true)}
              >
                <Icon name="refresh" />
              </button>
            </Show>
            <Menu
              id={`portal-${menuId}`}
              label={t("portalsPage.embeddedOptions")}
              trigger={<Icon name="moreHorizontal" />}
              triggerClass="session-panel-rail__button portals-embedded__action"
              placement="bottom-end"
              items={[
                ...(!props.mobile
                  ? [
                      {
                        id: "copy",
                        label: t("portalsPage.embeddedCopyLink"),
                        icon: <Icon name="copy" class="portals-embedded__menu-icon" />,
                      },
                    ]
                  : []),
                {
                  id: "open",
                  label: t(
                    props.mobile ? "portalsPage.embeddedOpenBrowser" : "portalsPage.embeddedOpen",
                  ),
                  icon: <Icon name="externalLink" class="portals-embedded__menu-icon" />,
                  href: portalUrl(),
                  attributes: { target: "_blank", rel: "noopener noreferrer" },
                  disabled: !canLaunch(),
                },
                {
                  id: "close",
                  label: t("portalsPage.embeddedClose"),
                  icon: <Icon name="x" class="portals-embedded__menu-icon" />,
                  disabled: !state().canClosePortal || props.closing === props.portal.id,
                },
              ]}
              onSelect={(item) => {
                if (item.id === "close") {
                  props.closePortal(props.portal);
                }
                if (item.id === "copy") {
                  void copyToClipboard(props.portal.publicUrl).then((copied) =>
                    showToast({
                      message: t(
                        copied ? "portalsPage.embeddedCopied" : "portalsPage.embeddedCopyFailed",
                      ),
                    }),
                  );
                }
              }}
            />
          </div>
        </header>
      </Show>
      <Show
        when={props.portal.tokenQuery && props.portal.url}
        fallback={
          <Show
            when={desktop()}
            fallback={
              <div class="portals-preview__notice" role="status">
                <div class="portals-preview__notice-title">
                  {t("portalsPage.writeAccessRequiredTitle")}
                </div>
                <p>{t("portalsPage.writeAccessRequiredBody")}</p>
              </div>
            }
          >
            <PanelEmptyState
              presentation="desktop"
              icon={<Icon name="lock" />}
              heading={t("portalsPage.writeAccessRequiredTitle")}
              description={t("portalsPage.embeddedWriteAccessBody")}
            />
          </Show>
        }
      >
        <Show when={!embedded()}>
          <header class="portals-preview__header">
            <a
              class="portals-preview__url"
              href={portalUrl()}
              target="_blank"
              rel="noopener noreferrer"
              title={displayUrl()}
            >
              <span>{displayUrl()}</span>
              <Icon name="externalLink" />
              <span class="sr-only">{t("portalsPage.openNewTab")}</span>
            </a>
            <button
              class="btn btn--icon btn--ghost portals-preview__close"
              type="button"
              title={t("portalsPage.closePortal", { title: props.portal.title })}
              aria-label={t("portalsPage.closePortal", { title: props.portal.title })}
              disabled={!state().canClosePortal || props.closing === props.portal.id}
              onClick={() => props.closePortal(props.portal)}
            >
              <Icon name="x" />
            </button>
          </header>
        </Show>
        <Show when={state().error}>
          <div class="callout danger portals-preview__error" role="alert">
            {state().error}
          </div>
        </Show>
        <Show
          when={probeStatus() === "probing"}
          fallback={
            <Show
              when={needsNotice()}
              fallback={
                <Show when={frameKey()} keyed>
                  {(_frameKey) => (
                    <iframe
                      class="portals-preview__frame"
                      src={portalUrl()}
                      title={t("portalsPage.previewTitle", { title: props.portal.title })}
                      referrerpolicy="no-referrer"
                      sandbox={PORTAL_FRAME_SANDBOX}
                    />
                  )}
                </Show>
              }
            >
              <Show
                when={desktop()}
                fallback={
                  <div class="portals-preview__notice" role="status">
                    <div class="portals-preview__notice-title">
                      {t(`portalsPage.${noticeKey()}Title`)}
                    </div>
                    <p>{t(`portalsPage.${noticeKey()}Body`)}</p>
                    <a
                      class="portals-preview__notice-url"
                      href={portalUrl()}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {displayUrl()}
                    </a>
                    <button
                      class="btn"
                      type="button"
                      onClick={() => props.model.ensurePortalProbe(props.portal, true)}
                    >
                      {t("portalsPage.retry")}
                    </button>
                  </div>
                }
              >
                <PanelEmptyState
                  presentation="desktop"
                  icon={<Icon name="panelsTopLeft" />}
                  heading={t(`portalsPage.${embeddedNoticeKey()}Title`)}
                  description={t(`portalsPage.${embeddedNoticeKey()}Body`)}
                  action={
                    <div
                      class="portals-embedded__recovery"
                      data-external-primary={probeStatus() === "new-tab-required" ? "" : undefined}
                    >
                      <button
                        class={["btn", { primary: probeStatus() !== "new-tab-required" }]}
                        type="button"
                        onClick={() => props.model.ensurePortalProbe(props.portal, true)}
                      >
                        <Icon name="refresh" />
                        {t("portalsPage.retry")}
                      </button>
                      <a
                        class={["btn", { primary: probeStatus() === "new-tab-required" }]}
                        href={portalUrl()}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Icon name="externalLink" />
                        {t("portalsPage.openNewTab")}
                      </a>
                    </div>
                  }
                />
              </Show>
            </Show>
          }
        >
          <div class="portals-empty portals-preview__state" role="status" aria-live="polite">
            <div class="portals-empty__title">{t("portalsPage.loading")}</div>
          </div>
        </Show>
      </Show>
    </section>
  );
}

function PortalReadiness(props: {
  model: PortalsModel;
  readReady: () => null;
  children: JSX.Element;
}) {
  return (
    <Loading
      on={!props.model.state().listReady ? props.model.state().listRead : null}
      fallback={
        <section class="portals-empty" role="status" aria-live="polite">
          <div class="portals-empty__title">{t("portalsPage.loading")}</div>
        </section>
      }
    >
      <Errored
        fallback={(error, reset) => (
          <section class="portals-empty" role="alert">
            <div class="callout danger">{formatUiError(error())}</div>
            <button
              class="btn"
              type="button"
              onClick={() => {
                void props.model.loadPresentation();
                reset();
              }}
            >
              {t("portalsPage.retry")}
            </button>
          </section>
        )}
      >
        {props.readReady()}
        {props.children}
      </Errored>
    </Loading>
  );
}

// The session host supplies mobile presentation; pane width is not a platform signal.
export function PortalContent(props: { model: PortalsModel; mobile?: boolean }) {
  const state = () => props.model.state();
  const receipt = createMemo(() => state().listRead);
  const ready = createMemo(async () => {
    const model = props.model;
    await receipt().result;
    const current = model.state();
    if (!current.listReady && current.error) {
      throw new Error(current.error);
    }
  });
  const epoch = createMemo(() => {
    state();
    return props.model.presentationEpoch;
  });
  const presentation = createMemo(() => {
    const currentEpoch = epoch();
    const [closing, setClosing] = createOptimistic<string | null>(null);
    return { epoch: currentEpoch, closing, setClosing };
  });
  const presentClose = action(function* (
    view: ReturnType<typeof presentation>,
    portalId: string,
    pending: Promise<void>,
    retired: Promise<void>,
  ) {
    if (view.epoch === props.model.presentationEpoch) {
      view.setClosing(portalId);
      affects(ready);
    }
    yield Promise.race([pending, retired]);
  });
  const closePortal = async (portal: PortalSummary) => {
    const view = presentation();
    if (!state().canClosePortal || state().closingPortalId) {
      return;
    }
    const retired = props.model.retired;
    const pending = props.model.closePortal(portal);
    await Promise.resolve();
    await presentClose(view, portal.id, pending, retired).catch((error: unknown) =>
      showToast({ message: formatUiError(error) }),
    );
  };
  const closing = () => presentation().closing() ?? state().closingPortalId;
  const readReady = () => {
    if (state().listReady) {
      latest(ready);
    } else {
      ready();
    }
    return null;
  };
  const environment = () =>
    state().pendingEnvironment?.id === state().pendingEnvironmentId
      ? state().pendingEnvironment
      : null;
  const environmentError = () =>
    state().environmentFailure?.environmentId === state().pendingEnvironmentId
      ? state().environmentFailure!.message
      : null;
  const failed = () =>
    environmentError() ||
    (environment() &&
      environment()!.status !== "starting" &&
      environment()!.status !== "available");
  const selectedPortal = createMemo(() =>
    state().portals.find(
      (portal) =>
        portal.id === (props.model.presentation().requestedPortalId ?? state().selectedPortalId),
    ),
  );
  return (
    <Show
      when={state().pendingEnvironmentId && (!state().connected || state().canReadPortalState)}
      fallback={
        <Show
          when={props.model.presentation().embedded}
          fallback={
            <>
              <HubPageHeader
                active="portals"
                wide
                docsUrl="https://docs.openclaw.ai/gateway/portals"
              />
              <PortalReadiness model={props.model} readReady={readReady}>
                <Show when={selectedPortal()} fallback={<EmptyState model={props.model} />}>
                  <section class="portals-layout">
                    <aside class="portals-rail" aria-label={t("portalsPage.listLabel")}>
                      <For each={state().portals} keyed={(portal) => portal.id}>
                        {(portal) => (
                          <button
                            class={[
                              "portals-rail__item",
                              { active: portal().id === selectedPortal()!.id },
                            ]}
                            type="button"
                            aria-current={portal().id === selectedPortal()!.id ? "true" : undefined}
                            onClick={() => props.model.selectPortal(portal())}
                          >
                            <span class="portals-rail__title">{portal().title}</span>
                            <span class="portals-rail__port">
                              {t("portalsPage.portLabel", { port: String(portal().port) })}
                            </span>
                            <Show when={portal().description}>
                              <span class="portals-rail__description">{portal().description}</span>
                            </Show>
                          </button>
                        )}
                      </For>
                    </aside>
                    <PortalPreview
                      model={props.model}
                      portal={selectedPortal()!}
                      closing={closing()}
                      closePortal={(portal) => void closePortal(portal)}
                    />
                  </section>
                </Show>
              </PortalReadiness>
            </>
          }
        >
          <div
            class="portals-embedded portals-page--embedded"
            data-mobile={props.mobile ? "" : undefined}
          >
            <PortalReadiness model={props.model} readReady={readReady}>
              <Show
                when={selectedPortal()}
                fallback={<EmptyState model={props.model} mobile={props.mobile} />}
              >
                <PortalPreview
                  model={props.model}
                  portal={selectedPortal()!}
                  mobile={props.mobile}
                  closing={closing()}
                  closePortal={(portal) => void closePortal(portal)}
                />
              </Show>
            </PortalReadiness>
          </div>
        </Show>
      }
    >
      <section class="portals-empty" role="status" aria-live="polite">
        <div class="portals-empty__title">
          {t(
            failed()
              ? "portalsPage.environmentUnavailable"
              : environment()?.status === "available"
                ? "portalsPage.waitingForApp"
                : "portalsPage.environmentStarting",
          )}
        </div>
        <Show when={environmentError() || environment()?.worker?.error}>
          <p>{environmentError() ?? environment()?.worker?.error}</p>
        </Show>
        <Show when={failed()}>
          <button
            class="btn"
            type="button"
            onClick={() => void props.model.loadPendingEnvironment()}
          >
            {t("portalsPage.retry")}
          </button>
        </Show>
      </section>
    </Show>
  );
}

export const PortalsPage = defineSolidBridge<PortalsPageProps, PortalsPageMethods>(
  "openclaw-portals-page",
  PortalsPageContent,
  {
    properties: {
      mobile: { default: false, type: Boolean },
      embedded: { default: false, type: Boolean, reflect: true },
      presented: { default: true, type: Boolean },
      requestedPortalId: { default: null, attribute: false },
      requestedEnvironmentId: { default: null, attribute: false },
    },
    propertyChanged: (host) => owners.get(host)?.presentationChanged(),
    methods: {
      handleToggleRequest(host: PortalsPageElement, event: Event) {
        const detail =
          // SAFETY: Portal panel toggle events use the shared panel-toggle-contract detail.
          event instanceof CustomEvent ? (event.detail as PortalPanelToggleDetail) : null;
        if (detail?.open === false) {
          return;
        }
        if (detail?.requestId) {
          owners.get(host)?.observePresentation(detail.requestId, detail.portalId);
        }
        if (
          detail?.portalId &&
          (detail.portalId !== host.requestedPortalId || host.requestedEnvironmentId !== null)
        ) {
          host.requestedPortalId = detail.portalId;
          host.requestedEnvironmentId = null;
        } else if (
          detail?.environmentId &&
          (detail.environmentId !== host.requestedEnvironmentId || host.requestedPortalId !== null)
        ) {
          host.requestedEnvironmentId = detail.environmentId;
          host.requestedPortalId = null;
        } else {
          void owners.get(host)?.loadPresentation();
        }
      },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-portals-page": PortalsPageElement;
  }
}
