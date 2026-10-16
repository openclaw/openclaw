import type { PortalSummary } from "@openclaw/gateway-protocol";
import { For, Show, createEffect, createMemo, onCleanup } from "solid-js";
import { titleForRoute } from "../../app-navigation.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import type { PortalPanelToggleDetail } from "../../components/panel-toggle-contract.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { registerPortalsEnglish } from "../../i18n/locales/en-portals.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
import { createPortals, type PortalsModel, type PortalsPresentation } from "./portals-state.ts";
import "./portals.css";

registerEnglishCatalog(registerPortalsEnglish);
const PORTAL_FRAME_SANDBOX =
  "allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts";
export type PortalsPageProps = PortalsPresentation;

type PortalsPageMethods = { handleToggleRequest(event: Event): void };
type PortalsPageElement = SolidBridgeElement<PortalsPageProps, PortalsPageMethods>;
const owners = new WeakMap<HTMLElement, PortalsModel>();

function PortalsPageContent(props: PortalsPageProps, host: PortalsPageElement) {
  const model = createPortals(useApplication(), () => props);
  owners.set(host, model);
  onCleanup(() => owners.delete(host));
  createEffect(
    () => ({ ...props }),
    (_value, previous) => model.presentationChanged(previous),
  );
  return (
    <ShellLayoutBoundary traits={{ toolbarHeader: !props.embedded }}>
      <PortalContent model={model} />
    </ShellLayoutBoundary>
  );
}

function EmptyState(props: { model: PortalsModel }) {
  const state = () => props.model.state();
  return (
    <section class="portals-empty" role="status" aria-live="polite">
      <Show
        when={state().connected && !state().canReadPortalState}
        fallback={
          <>
            <Show
              when={state().loading && !state().loaded}
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
  );
}

function PortalPreview(props: { model: PortalsModel; portal: PortalSummary }) {
  const state = () => props.model.state();
  const portalUrl = () => props.portal.url ?? "";
  const displayUrl = createMemo(() => {
    if (!portalUrl()) {
      return "";
    }
    const value = new URL(portalUrl());
    value.search = "";
    return value.href;
  });
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
  return (
    <section class="portals-preview">
      <Show
        when={props.portal.tokenQuery && props.portal.url}
        fallback={
          <div class="portals-preview__notice" role="status">
            <div class="portals-preview__notice-title">
              {t("portalsPage.writeAccessRequiredTitle")}
            </div>
            <p>{t("portalsPage.writeAccessRequiredBody")}</p>
          </div>
        }
      >
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
            disabled={!state().canClosePortal || state().closingPortalId === props.portal.id}
            onClick={() => void props.model.closePortal(props.portal)}
          >
            <Icon name="x" />
          </button>
        </header>
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

function PortalContent(props: { model: PortalsModel }) {
  const state = () => props.model.state();
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
              <section class="content-header content-header--page">
                <div>
                  <h1 class="page-title">{titleForRoute("portals")}</h1>
                </div>
              </section>
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
                  <PortalPreview model={props.model} portal={selectedPortal()!} />
                </section>
              </Show>
            </>
          }
        >
          <div class="portals-embedded">
            <Show when={selectedPortal()} fallback={<EmptyState model={props.model} />}>
              <PortalPreview model={props.model} portal={selectedPortal()!} />
            </Show>
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
      embedded: { default: false, type: Boolean, reflect: true },
      presented: { default: true, type: Boolean },
      requestedPortalId: { default: null, attribute: false },
      requestedEnvironmentId: { default: null, attribute: false },
    },
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
