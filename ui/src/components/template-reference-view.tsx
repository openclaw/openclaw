import { createMemo, createUniqueId, Errored, lazy, Loading, Show } from "solid-js";
import type { ApplicationContext } from "../app/context.ts";
import { registerTemplatesEnglish } from "../i18n/locales/en-templates.ts";
import { ApplicationProvider } from "../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { TemplateArtwork } from "../pages/agents-home/template-artwork.tsx";
import { searchTemplates } from "../pages/agents-home/templates-catalog-client.ts";
import { Popover } from "./solid/popover.tsx";
import type { TemplateReference } from "./template-reference-surface.tsx";
import "../styles/template-reference.css";

registerEnglishCatalog(registerTemplatesEnglish);
const TemplateDialog = lazy(() => import("../pages/agents-home/templates-catalog-dialog.tsx"), {
  export: "TemplatesCatalogDialog",
});

export function TemplateReferenceView(props: {
  application?: ApplicationContext;
  active: TemplateReference | null;
  preview: TemplateReference | null;
  onDismiss: () => void;
  onKeep: () => void;
  onLeave: () => void;
  onOpen: (value: TemplateReference) => void;
  onClose: () => void;
}) {
  const id = createUniqueId();
  return (
    <>
      <Show when={props.active} keyed>
        {(value) => {
          const entry = createMemo(
            async () =>
              (await searchTemplates(value.client, value.packageName, 100)).find(
                (item) => item.packageName === value.packageName,
              ) ?? null,
          );
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
                onPointerEnter={() => props.onKeep()}
                onPointerLeave={() => props.onLeave()}
                onFocusIn={() => props.onKeep()}
                onFocusOut={() => props.onLeave()}
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
                  onClick={() => props.onOpen(value)}
                >
                  {t("templatesCatalog.viewTemplate")}
                </button>
              </div>
            </Popover>
          );
        }}
      </Show>
      <Show when={props.preview && props.application} keyed>
        {(application) => (
          <ApplicationProvider value={application}>
            <TemplateDialog
              initialPackageName={props.preview!.packageName}
              modal
              onClose={() => props.onClose()}
            />
          </ApplicationProvider>
        )}
      </Show>
    </>
  );
}
