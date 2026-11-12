import { expect, it } from "vitest";
import type { StatusSummary } from "../status/summary.ts";
import { buildStatusAllOverviewRows } from "./status-overview-rows.ts";
import { createStatusCommandOverviewRowsParams } from "./status.test-support.ts";

const reloadReason =
  "Plugin replacement queued behind 2 retained work item(s) for plugin composio, lobster; new agent runs wait up to the 600s drain budget. Press Ctrl+C to cancel the waiting reload.";
const osc = "\x1b]0;PWNED\x07";
const degradedPlugin = {
  pluginId: `bad${osc}`,
  state: "configured-unavailable",
  diagnostic: { kind: "plugin-verification", reason: "missing-install-path", detail: "x" },
} satisfies NonNullable<StatusSummary["degradedPlugins"]>[number];
const secretEgressProxy = {
  state: "degraded",
  caExpiresAt: "2026-12-31",
  failedCertificates: 1,
  message: `cert${osc}`,
} satisfies NonNullable<StatusSummary["secretEgressProxy"]>;

it("shows pending plugin reloads in the status-all overview", () => {
  const params = createStatusCommandOverviewRowsParams();
  const rows = buildStatusAllOverviewRows({
    ...params,
    summary: {
      ...params.summary,
      pluginReload: {
        phase: "reloading",
        pluginIds: ["composio", "lobster"],
        reason: reloadReason,
      },
    },
    configPath: "/fixture/openclaw.json",
    secretDiagnosticsCount: 0,
  });

  expect(rows.find(({ Item }) => Item === "Plugin reload")?.Value).toBe(
    `reloading composio, lobster · ${reloadReason}`,
  );
});

it("strips terminal control sequences from Gateway-sourced degradation rows", () => {
  const params = createStatusCommandOverviewRowsParams();
  const rows = buildStatusAllOverviewRows({
    ...params,
    summary: {
      ...params.summary,
      pluginReload: {
        phase: "reloading",
        pluginIds: [`composio${osc}`, `lobster\x07`],
        reason: `queued\x1b[31m`,
      },
      degradedPlugins: [degradedPlugin],
      secretEgressProxy,
      utilityModelWarnings: [{ path: `/p${osc}`, message: `m\x07` }],
    },
    configPath: "/fixture/openclaw.json",
    secretDiagnosticsCount: 0,
  });

  const serialized = rows.map((row) => row.Value).join("");
  expect(serialized).not.toContain("\x1b");
  expect(serialized).not.toContain("\x07");
  expect(serialized).toContain("reloading");
  expect(serialized).toContain("composio");
  expect(serialized).toContain("bad");
});
