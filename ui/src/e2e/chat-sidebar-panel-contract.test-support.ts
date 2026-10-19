import type { Page } from "playwright";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";

export async function seedMainCompanionLayout(
  page: Page,
  baseUrl: string,
  mainCompanionKey: string,
): Promise<void> {
  // Main Companion retains Clear; side Companion uses its confirmed tab-close operation.
  await page.addInitScript(
    ({ key, sessionKey }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          sidebarSessionLayouts: {
            [sessionKey]: {
              columns: [
                {
                  id: "side-panel-column",
                  side: "right",
                  panels: ["companion", "workspace", "conversation"].map((slot) => ({
                    id: slot,
                    slot,
                  })),
                  activePanelId: "workspace",
                  width: 480,
                  height: 360,
                },
              ],
              mainPanelId: "companion",
              open: true,
            },
          },
        }),
      );
    },
    {
      key: controlUiBundledSettingsStorageKey(baseUrl),
      sessionKey: mainCompanionKey,
    },
  );
}
