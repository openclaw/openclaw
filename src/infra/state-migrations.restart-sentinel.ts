import path from "node:path";
import { assertNoRetiredStateFiles } from "./state-migrations.retired-files.js";

export function assertNoRetiredRestartSentinelFiles(stateDir: string): void {
  assertNoRetiredStateFiles("Restart sentinel JSON", [
    path.join(stateDir, "restart-sentinel.json"),
    path.join(stateDir, "restart-sentinel.json.doctor-importing"),
  ]);
}
