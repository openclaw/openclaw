import fs from "node:fs/promises";
import path from "node:path";
import { writeJson } from "../../infra/json-files.js";
import { untrackClawHubSkill } from "./clawhub-store.js";
import type { WorkspaceSkillLifecycle } from "./workspace-types.js";

export type { SkillSourceOrigin } from "./workspace-types.js";

/** Source tracking lives beside the installed skill, including ClawHub replacement cleanup. */
export async function recordSkillSourceInstall(
  params: Parameters<WorkspaceSkillLifecycle["recordSkillSourceInstall"]>[0],
): Promise<void> {
  await Promise.all([
    fs.rm(path.join(params.targetDir, ".clawhub"), { recursive: true, force: true }),
    fs.rm(path.join(params.targetDir, ".clawdhub"), { recursive: true, force: true }),
  ]);
  await writeJson(path.join(params.targetDir, ".openclaw", "source-origin.json"), params.origin, {
    trailingNewline: true,
  });
  await untrackClawHubSkill(params.workspaceDir, params.origin.slug);
}
