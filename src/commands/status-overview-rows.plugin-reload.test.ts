import { expect, it } from "vitest";
import { buildStatusAllOverviewRows } from "./status-overview-rows.ts";
import { createStatusCommandOverviewRowsParams } from "./status.test-support.ts";

it("shows pending plugin reloads in the status-all overview", () => {
  const params = createStatusCommandOverviewRowsParams();
  const rows = buildStatusAllOverviewRows({
    ...params,
    summary: {
      ...params.summary,
      pluginReload: {
        phase: "reloading",
        pluginIds: ["composio", "lobster"],
        reason:
          "Plugin replacement queued behind 2 retained work item(s) for plugin composio, lobster; new agent runs wait up to the 600s drain budget. Press Ctrl+C to cancel the waiting reload.",
      },
    },
    configPath: "/fixture/openclaw.json",
    secretDiagnosticsCount: 0,
  });

  expect(rows.find(({ Item }) => Item === "Plugin reload")?.Value).toBe(
    "reloading composio, lobster · Plugin replacement queued behind 2 retained work item(s) for plugin composio, lobster; new agent runs wait up to the 600s drain budget. Press Ctrl+C to cancel the waiting reload.",
  );
});
