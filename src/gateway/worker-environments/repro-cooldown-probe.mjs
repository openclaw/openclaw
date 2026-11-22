#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  [
    "scripts/run-vitest.mjs",
    "src/gateway/worker-environments/worker-turn-launcher-failure-recovery.test.ts",
    "--maxWorkers=1",
    "--reporter=dot",
    "--disableConsoleIntercept",
    "-t",
    "proves cooldown behavior through Gateway RPC and worker/provider boundaries",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_EXPECT_PROBE_RETRY: process.env.OPENCLAW_EXPECT_PROBE_RETRY ?? "true",
    },
  },
);

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
