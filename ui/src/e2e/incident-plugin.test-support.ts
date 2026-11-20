import path from "node:path";
import type { NativeControlUiPluginFixture } from "../test-helpers/control-ui-plugin-fixture.ts";

export function incidentPluginFixture(
  inlineViews: NativeControlUiPluginFixture["inlineViews"],
): NativeControlUiPluginFixture {
  return {
    pluginId: "incident-tools",
    rootDir: path.resolve("examples/inline-incident"),
    source: "./control-ui.ts",
    inlineViews,
  };
}
