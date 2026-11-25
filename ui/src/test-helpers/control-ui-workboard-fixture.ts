import path from "node:path";
import type { NativeControlUiMockGatewayScenario } from "./control-ui-plugin-e2e.ts";
import type { NativeControlUiPluginFixture } from "./control-ui-plugin-fixture.ts";

const workboardNativePlugins: NativeControlUiPluginFixture[] = [
  {
    pluginId: "workboard",
    rootDir: path.resolve(import.meta.dirname, "../../../extensions/workboard"),
    source: "browser/index.ts",
  },
];

export const workboardUi = {
  nativePlugins: workboardNativePlugins,
  controlUiTabs: [
    {
      pluginId: "workboard",
      id: "workboard",
      label: "Workboard",
      placement: "route:workboard",
      icon: "kanban",
      group: "control",
    },
  ],
} satisfies Pick<NativeControlUiMockGatewayScenario, "nativePlugins" | "controlUiTabs">;
