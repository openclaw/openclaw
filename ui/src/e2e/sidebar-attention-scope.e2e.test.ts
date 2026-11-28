// Control UI browser proof covers agent scope and Inbox independence.
import path from "node:path";
import { it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { runSidebarAttentionScopeFlow } from "./sidebar-attention-scope.e2e.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI automation indicator scope",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("scopes the automation indicator and keeps it through Inbox dismissal", async () => {
    await runSidebarAttentionScopeFlow({
      get artifactDir() {
        return path.join(suite.artifactDir, "automation-indicator-scope");
      },
      baseUrl: suite.server.baseUrl,
      browser: suite.browser,
      captureProof: false,
    });
  });
});
