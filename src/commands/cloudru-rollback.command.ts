/**
 * CLI command: cloudru-rollback
 *
 * Removes Cloud.ru FM configuration from openclaw.json.
 * Leaves .env file and Docker Compose file untouched.
 */

import path from "node:path";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { rollbackCloudruFmConfig } from "./cloudru-rollback.js";

type CloudruRollbackOptions = {
  configPath?: string;
  json?: boolean;
};

export async function cloudruRollbackCommand(
  opts: CloudruRollbackOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const configPath = opts.configPath ?? path.join(process.cwd(), "openclaw.json");

  const result = await rollbackCloudruFmConfig(configPath);

  if (opts.json) {
    runtime.log(JSON.stringify(result));
    return;
  }

  if (result.rolled) {
    runtime.log("Cloud.ru FM configuration removed from openclaw.json.");
    runtime.log("Note: .env file and Docker Compose file were NOT removed.");
    runtime.log("To stop the proxy: docker compose -f docker-compose.cloudru-proxy.yml down");
  } else {
    runtime.log(`Nothing to roll back: ${result.reason}`);
  }
}
