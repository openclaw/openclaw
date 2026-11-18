import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { z } from "zod";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRuntimeWorkerUrl } from "../runtime-worker-url.js";
import { logbookPortProvider } from "./logbook-port.js";
import { teamReportsPortProvider } from "./team-reports-port.js";
import { updatePreflightTeamReportsEntrypoint } from "./update-preflight.runtime.test-support.js";
import { workboardPortProvider } from "./workboard-port.js";

/** Load the real public API without rebuilding its source SDK in every capture child. */
export async function createTeamReportsPortFixture(root: string, sourceRoot: string) {
  const artifact = resolveRuntimeWorkerUrl(updatePreflightTeamReportsEntrypoint);
  await fs.mkdir(root, { recursive: true });
  await fs.copyFile(
    path.join(sourceRoot, "openclaw.plugin.json"),
    path.join(root, "openclaw.plugin.json"),
  );
  const manifest = z
    .looseObject({
      openclaw: z.looseObject({ extensions: z.array(z.string()) }),
    })
    .parse(JSON.parse(await fs.readFile(path.join(sourceRoot, "package.json"), "utf8")));
  manifest.openclaw.extensions = ["./index.js"];
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(root, "index.js"), "export default {};\n");
  await fs.writeFile(
    path.join(root, "database-port-api.js"),
    `export { teamReportsDatabasePortApi } from ${JSON.stringify(artifact.href)};\n`,
  );
  return root;
}

export async function activateUpdatePostgresPluginFixtures(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  bundledRoot: string,
) {
  await fs.writeFile(env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config));
  env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "0";
  env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledRoot;
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", env.OPENCLAW_DISABLE_BUNDLED_PLUGINS);
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", env.OPENCLAW_BUNDLED_PLUGINS_DIR);
}

export const updatePostgresFamilies = [
  {
    provider: workboardPortProvider,
    relativePath: "plugins/workboard/workboard.sqlite",
    seed: "PRAGMA user_version=3; INSERT INTO workboard_schema_migrations VALUES ('schema-3',1); INSERT INTO workboard_boards (id,name,created_at,updated_at) VALUES ('board','baseline',1,1)",
    table: "workboard_boards",
    column: "name",
  },
  {
    provider: logbookPortProvider,
    relativePath: "logbook/logbook.sqlite",
    seed: "PRAGMA user_version=1; INSERT INTO standups VALUES ('2026-10-16','baseline',1)",
    table: "standups",
    column: "text",
  },
  {
    provider: teamReportsPortProvider,
    relativePath: "plugins/team-reports/team-reports.sqlite",
    seed: "PRAGMA user_version=1; INSERT INTO team_reports_schema_migrations VALUES ('schema-1',1); INSERT INTO team_reports_periods VALUES ('day','2026-10-16',1,2,'closed',2,'{}',NULL,'baseline')",
    table: "team_reports_periods",
    column: "markdown",
  },
];
