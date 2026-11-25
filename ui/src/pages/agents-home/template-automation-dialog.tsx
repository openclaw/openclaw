import { createSignal, Show } from "solid-js";
import { ModalDialog } from "../../components/modal-dialog.tsx";
import { DialogHeader } from "../../components/solid/dialog-header.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { createTemplateAutomationSummary } from "./template-automation-summary.ts";
import type { TemplateCatalogDetail } from "./templates-catalog-client.ts";

type Automation = TemplateCatalogDetail["contents"]["automations"][number];

/** Catalog and chat preview share the row summary and read-only automation dialog. */
export function createTemplateAutomationDialog() {
  const [selected, select] = createSignal<Automation>();
  const summary = createTemplateAutomationSummary();
  const close = () => select(undefined);
  const Dialog = () => (
    <Show when={selected()}>
      {(item) => (
        <ModalDialog
          label={item().name}
          description={summary(item())}
          style={{ "--openclaw-modal-width": "initial" }}
          onModal-cancel={(event: Event) => {
            // Escape from an automation must leave the containing Template preview open.
            event.stopPropagation();
            close();
          }}
        >
          <article class="oc-dialog">
            <DialogHeader
              title={
                <>
                  <span class="plugin-capability__icon" aria-hidden="true">
                    <Icon name="clock" />
                  </span>
                  {item().name}
                </>
              }
              description={summary(item())}
              onClose={close}
            />
            <div class="oc-dialog__body template-automation-message">{item().message}</div>
          </article>
        </ModalDialog>
      )}
    </Show>
  );
  return { open: (item: Automation) => select(item), summary, Dialog };
}
