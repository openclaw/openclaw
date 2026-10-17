import { createEffect, onSettled, untrack } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { DockResizer } from "../dock-layout-solid.tsx";
import type { BrowserPanelPresentation } from "./browser-panel-presentation.ts";
import { BrowserPanelChrome } from "./browser-panel-render.tsx";

export function BrowserPanelContent(props: { owner: BrowserPanelPresentation }) {
  // The native bridge retains this synchronous owner for the host's lifetime.
  const owner = untrack(() => props.owner);
  const state = projectOwner(owner, (current) => current);
  // Native presentation and viewport geometry follow the committed DOM.
  createEffect(state.revision, () => owner.rendered());
  onSettled(() => {
    let disposed = false;
    let detach: (() => void) | undefined;
    const connect = () => {
      if (!disposed && owner.inputs.isConnected) {
        detach = owner.attach();
      }
    };
    // Direct Solid hosts settle before their parent inserts them.
    if (owner.inputs.isConnected) {
      connect();
    } else {
      queueMicrotask(connect);
    }
    return () => {
      disposed = true;
      detach?.();
    };
  });
  const panel = state.read;
  return (
    <>
      {panel().inputs.available && (panel().inputs.embedded || panel().dockLayout.open) ? (
        <BrowserPanelChrome
          controller={panel().browser}
          dock={panel().dockLayout.dock}
          height={panel().dockLayout.height}
          width={panel().dockLayout.width}
          onDockChange={(dock) => panel().dockLayout.setDock(dock)}
          onClose={() => panel().closePanel()}
          resizer={
            <DockResizer
              controller={panel().dockLayout}
              classPrefix="bp"
              label={t("browser.resize")}
            />
          }
          embedded={panel().inputs.embedded}
          tabsInHeader={panel().inputs.tabsInHeader}
        />
      ) : null}
    </>
  );
}
