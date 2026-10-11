import { untrack } from "@solidjs/signals";
import { t } from "../../lib/reactive/i18n.ts";
import { DockResizer } from "../dock-layout-solid.tsx";
import { usePanelController } from "../solid-panel-controller.ts";
import type { BrowserPanelPresentation } from "./browser-panel-presentation.ts";
import { BrowserPanelChrome } from "./browser-panel-render.tsx";

export function BrowserPanelContent(props: { controller: BrowserPanelPresentation }) {
  const controller = untrack(() => props.controller);
  usePanelController(controller);
  const panel = () => controller.read();
  return (
    <>
      {panel().available && (panel().embedded || panel().dockLayout.open) ? (
        <BrowserPanelChrome
          controller={panel().browserPanelController}
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
          embedded={panel().embedded}
          tabsInHeader={panel().tabsInHeader}
        />
      ) : null}
    </>
  );
}
