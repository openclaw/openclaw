import { createTempDirTracker } from "../../../test/helpers/temp-dir.ts";
import { startProductionControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { defineGatewayModuleBoundaryTests } from "./gateway-module-boundaries.test-support.ts";
import { defineNativeModuleBoundaryTests } from "./native-module-boundaries.test-support.ts";
import { defineSessionPlacementModuleBoundaryTests } from "./session-placement-module-boundaries.test-support.ts";
import { defineTypographyModuleBoundaryTests } from "./typography-module-boundaries.test-support.ts";

const tempDirs = createTempDirTracker();
let buildRoot: string;
const suite = createControlUiE2eSuite({
  name: "Control UI module boundaries",
  trackBrowserContexts: true,
  startServer: async () => {
    buildRoot = tempDirs.make("openclaw-ui-module-boundaries-");
    try {
      // Fault individual import owners without changing production preload,
      // service-worker, or reload behavior. Other suites retain shipped grouping.
      const server = await startProductionControlUiE2eServer(buildRoot, "e2e", undefined, {
        includeBootGroups: false,
      });
      return {
        ...server,
        close: async () => {
          await server.close();
          tempDirs.cleanup();
        },
      };
    } catch (error) {
      tempDirs.cleanup();
      throw error;
    }
  },
});
const moduleRequest = (sourcePath: string) => controlUiE2eBuiltModuleRequest(sourcePath, buildRoot);

suite.define(() => {
  defineGatewayModuleBoundaryTests(suite, moduleRequest);
  defineNativeModuleBoundaryTests(suite, moduleRequest);
  defineSessionPlacementModuleBoundaryTests(suite, moduleRequest);
  defineTypographyModuleBoundaryTests(suite, moduleRequest);
});
