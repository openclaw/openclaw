import {
  createMemo,
  createSignal,
  createUniqueId,
  Errored,
  lazy,
  Loading,
  onSettled,
  Show,
} from "solid-js";
import type { ApplicationContext } from "../app/context.ts";
import { registerTemplatesEnglish } from "../i18n/locales/en-templates.ts";
import { ApplicationProvider } from "../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { listen } from "../lib/reactive/listener.ts";
import { createTimeout } from "../lib/reactive/timers.ts";
import { TemplateArtwork } from "../pages/agents-home/template-artwork.tsx";
import { searchTemplates } from "../pages/agents-home/templates-catalog-client.ts";
import { Popover } from "./solid/popover.tsx";
import type { TemplateReference, TemplateReferenceSource } from "./template-reference-surface.tsx";
import "../styles/templates-catalog.css";

registerEnglishCatalog(registerTemplatesEnglish);
const TemplateDialog = lazy(() => import("../pages/agents-home/templates-catalog-dialog.tsx"), {
  export: "TemplatesCatalogDialog",
});

export function TemplateReferenceView(props: {
  presented: boolean;
  source: TemplateReferenceSource;
  intent: TemplateReference;
  onDismiss: () => void;
}) {
  const current = () =>
    props.presented &&
    props.intent.client === props.source().gatewayClient &&
    props.intent.sessionKey === props.source().sessionKey;
  return (
    <Show when={current() && props.source().applicationContext}>
      {(application) => (
        <Show when={props.intent.anchor} keyed>
          {(_anchor) => (
            <ScopedTemplateReferenceView
              application={application()}
              intent={props.intent}
              onDismiss={props.onDismiss}
            />
          )}
        </Show>
      )}
    </Show>
  );
}

function ScopedTemplateReferenceView(props: {
  application: ApplicationContext;
  intent: TemplateReference;
  onDismiss: () => void;
}) {
  const [opened, setOpened] = createSignal<TemplateReference | null>(null);
  // A click is an opening command, not hover state; leaving must not close its modal.
  onSettled(() => {
    if (props.intent.type === "click") {
      setOpened(props.intent);
    }
  });
  const preview = () => (props.intent.type === "click" ? props.intent : opened());
  const close = createTimeout(() => {
    if (!preview()) {
      props.onDismiss();
    }
  }, 180);
  // Hover/leave commands do not replace the card or repeat its catalog read.
  const target = createMemo(() => props.intent, {
    equals: (a, b) =>
      a.anchor === b.anchor && a.client === b.client && a.sessionKey === b.sessionKey,
  });
  // These listeners only exist while a reference is mounted, never at chat boot.
  onSettled(() => {
    const initialAnchor = target().anchor;
    const leave = () => close.schedule();
    const enter = () => close.cancel();
    const stops = [
      listen(initialAnchor, "pointerleave", leave),
      listen(initialAnchor, "focusout", leave),
      listen(initialAnchor, "pointerenter", enter),
      listen(initialAnchor, "focusin", enter),
    ];
    // A cold lazy load can finish after the pointer already left the initialAnchor.
    if (!initialAnchor.matches(":hover, :focus")) {
      leave();
    }
    return () => stops.forEach((stop) => stop());
  });
  const id = createUniqueId();
  return (
    <>
      <Show when={!preview() && target()} keyed>
        {(value) => {
          const entry = createMemo(async () => {
            const packageName = value.anchor.dataset.templatePackage;
            return packageName
              ? ((await searchTemplates(value.client, packageName, 100)).find(
                  (item) => item.packageName === packageName,
                ) ?? null)
              : null;
          });
          return (
            <Popover
              id={id}
              label={t("templatesCatalog.review")}
              anchor={value.anchor}
              open
              placement="bottom-start"
              dismissOutsideFocus={false}
              onOpenChange={(isOpen) => {
                if (!isOpen) {
                  props.onDismiss();
                }
              }}
              class="template-reference-card"
            >
              <div
                onPointerEnter={() => close.cancel()}
                onPointerLeave={() => close.schedule(180)}
                onFocusIn={() => close.cancel()}
                onFocusOut={() => close.schedule(180)}
              >
                <Errored fallback={() => <p role="status">{t("templatesCatalog.unavailable")}</p>}>
                  <Loading fallback={<p role="status">{t("templatesCatalog.loading")}</p>}>
                    <Show
                      when={entry()}
                      fallback={<p role="status">{t("templatesCatalog.unavailable")}</p>}
                    >
                      {(item) => (
                        <>
                          <header>
                            <span class="template-reference-card__art">
                              <TemplateArtwork src={item().iconUrl} />
                            </span>
                            <span>
                              <strong>{item().displayName}</strong>
                              <small>
                                {t("templatesCatalog.byCreator", {
                                  creator: `@${item().ownerHandle}`,
                                })}
                              </small>
                            </span>
                          </header>
                          <p>{item().summary}</p>
                        </>
                      )}
                    </Show>
                  </Loading>
                </Errored>
                <button
                  type="button"
                  class="btn template-reference-card__view"
                  onClick={() => setOpened(value)}
                >
                  {t("templatesCatalog.viewTemplate")}
                </button>
              </div>
            </Popover>
          );
        }}
      </Show>
      <Show when={preview() && props.application} keyed>
        {(application) => (
          <ApplicationProvider value={application}>
            <TemplateDialog
              initialPackageName={preview()!.anchor.dataset.templatePackage!}
              modal
              onClose={() => {
                const anchor = preview()?.anchor;
                props.onDismiss();
                onSettled(() => {
                  if (anchor?.isConnected) {
                    anchor.focus({ preventScroll: true });
                  }
                });
              }}
            />
          </ApplicationProvider>
        )}
      </Show>
    </>
  );
}
