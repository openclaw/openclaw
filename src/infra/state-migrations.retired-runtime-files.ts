import os from "node:os";
import path from "node:path";
import { resolveRequiredHomeDir } from "./home-dir.js";
import { assertNoRetiredStateFiles } from "./state-migrations.retired-files.js";

export function listImportableRetiredRuntimeStateFiles(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string[] {
  const defaultStateDir = path.join(resolveRequiredHomeDir(env, homedir), ".openclaw");
  return [
    path.join(stateDir, "settings", "voicewake.json"),
    path.join(stateDir, "settings", "voicewake-routing.json"),
    path.join(stateDir, "bindings", "current-conversations.json"),
    // The retired approval writer always used the default home, independently of profiles.
    ...(path.resolve(stateDir) === path.resolve(defaultStateDir)
      ? [path.join(defaultStateDir, "plugin-binding-approvals.json")]
      : []),
  ];
}

export function listRetiredRuntimeStateFiles(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string[] {
  return [
    ...listImportableRetiredRuntimeStateFiles(stateDir, env, homedir),
    path.join(stateDir, "acp", "event-ledger.json"),
    path.join(stateDir, "acp", "event-ledger.json.doctor-import"),
    path.join(stateDir, "restart-sentinel.json"),
    path.join(stateDir, "restart-sentinel.json.doctor-importing"),
  ];
}

export function assertNoRetiredRuntimeStateFiles(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): void {
  assertNoRetiredStateFiles(
    "Runtime JSON sidecars",
    listRetiredRuntimeStateFiles(stateDir, env, homedir),
  );
}
