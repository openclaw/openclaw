#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const result = spawnSync(
  "pnpm",
  [
    "test",
    "src/gateway/server.chat.gateway-server-chat.test.ts",
    "--maxWorkers=1",
    "--testNamePattern=activates managed-media filtering after tool output before later Gateway deltas",
  ],
  {
    stdio: "inherit",
    env: { ...process.env, OPENCLAW_GATEWAY_STREAM_PROOF: "1" },
  },
);

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
