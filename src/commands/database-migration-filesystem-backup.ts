import path from "node:path";
import { z } from "zod";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../infra/home-dir.js";
import {
  parseUpdateStateInspectionWorker,
  runUpdateStateInspectionWorker,
} from "../infra/update-candidate-state.inspection.js";

/** Leave renewal responsive while the existing child owns blocking backup work. */
export async function createDatabaseMigrationFilesystemBackup(params: {
  output: string;
  stateDir: string;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}): Promise<void> {
  const result = await runUpdateStateInspectionWorker({
    input: {
      mode: "migration-filesystem-backup",
      output: params.output,
      userPathBaseDirectory: resolveUserPath("."),
      stateDir: params.stateDir,
      config: params.config,
    },
    nodeRunner: process.execPath,
    sourceEnv: params.env,
    stagingRoot: path.dirname(params.output),
    databases: [],
    signal: params.signal,
    // Bound the full private-copy/verification lifecycle independently of the
    // renewable 120s suspension; large filesystem archives can take many minutes.
    timeoutMs: 30 * 60_000,
    ioBudget: "deadline",
  });
  parseUpdateStateInspectionWorker(
    result,
    z.object({ archivePath: z.literal(params.output), verified: z.literal(true) }),
  );
}
