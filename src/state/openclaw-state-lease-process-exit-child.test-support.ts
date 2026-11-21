import { withOpenClawStateLease } from "./openclaw-state-lease.js";

const stateDir = process.argv[2];
if (!stateDir) {
  throw new Error("state lease process-exit child requires a state directory");
}
const heartbeat = process.argv[3] === "worker" ? "worker" : undefined;

await withOpenClawStateLease(
  {
    scope: "core:test",
    key: "process-exit",
    database: {
      scope: "shared",
      options: { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
    },
    leaseMs: 300_000,
    waitMs: 0,
    heartbeat,
    processBound: process.argv[5] === "process-bound",
  },
  async () => {
    if (process.argv[4] === "SIGKILL") {
      process.kill(process.pid, "SIGKILL");
    } else {
      process.exit(23);
    }
  },
);
