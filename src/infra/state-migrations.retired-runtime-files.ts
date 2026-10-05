import os from "node:os";
import path from "node:path";
import { resolveRequiredHomeDir } from "./home-dir.js";
import { assertNoRetiredRestartSentinelFiles } from "./state-migrations.restart-sentinel.js";
import { assertNoRetiredStateFiles } from "./state-migrations.retired-files.js";

export function assertNoRetiredRuntimeStateFiles(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): void {
  const defaultStateDir = path.join(resolveRequiredHomeDir(env, homedir), ".openclaw");
  assertNoRetiredStateFiles("Runtime JSON sidecars", [
    path.join(stateDir, "update-check.json"),
    path.join(stateDir, "acp", "event-ledger.json"),
    path.join(stateDir, "acp", "event-ledger.json.doctor-import"),
    path.join(stateDir, "settings", "voicewake.json"),
    path.join(stateDir, "settings", "voicewake-routing.json"),
    path.join(stateDir, "bindings", "current-conversations.json"),
    // The retired approval writer always used the default home, independently of profiles.
    ...(path.resolve(stateDir) === path.resolve(defaultStateDir)
      ? [path.join(defaultStateDir, "plugin-binding-approvals.json")]
      : []),
  ]);
  assertNoRetiredRestartSentinelFiles(stateDir);
}
