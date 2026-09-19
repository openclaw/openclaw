import { it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { exerciseLogsReconnect } from "./settings-reconnect-layout.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Settings reconnect stream layout" });

suite.define(() => {
  it.each([
    { width: 1440, height: 900, reader: true, bounded: true },
    { width: 1440, height: 900, reader: false, bounded: true },
    { width: 863, height: 584, reader: true, bounded: true },
    { width: 390, height: 844, reader: true, bounded: false },
    { width: 844, height: 390, reader: true, bounded: false },
  ])(
    "preserves reading and follow behavior at $width × $height (reader: $reader)",
    async (cell) => {
      await suite.withPage(
        {
          viewport: { width: cell.width, height: cell.height },
          deviceScaleFactor: 2,
          locale: "en-US",
        },
        async ({ page }) => {
          await exerciseLogsReconnect(page, suite.server.baseUrl, cell);
        },
      );
    },
  );
});
