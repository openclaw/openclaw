import { dirname, resolve, sep } from "node:path";
import { toAgentEntriesRecord } from "../agents/agent-scope.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import { configuredPlanDigest, configuredSourceIntegrity } from "./add-checkpoint.js";
import { templateContainedRelativePath } from "./path-containment.js";
import type { TemplateAddPlan } from "./types.js";

export type TemplateInitializationIntent = NonNullable<
  NonNullable<SessionEntry["templateInitialization"]>["preparing"]
>;

/** The canonical pending session owns intended additions before any file/config effect. */
export async function prepareTemplateInitializationIntent(
  plan: TemplateAddPlan,
): Promise<TemplateInitializationIntent> {
  const workspace = resolve(plan.agent.workspace);
  const root = await fsSafeRoot(workspace);
  const workspaceAdditions: Record<string, string | null> = {};
  for (const action of plan.actions) {
    if (action.kind !== "workspaceFile") {
      continue;
    }
    const path = templateContainedRelativePath(workspace, resolve(action.target));
    if (!path || !action.digest || (await root.exists(path))) {
      throw new Error("Template instruction target changed before initialization intent");
    }
    workspaceAdditions[path.split(sep).join("/")] = action.digest;
    for (
      let parent = dirname(path);
      parent !== "." && !(await root.exists(parent));
      parent = dirname(parent)
    ) {
      workspaceAdditions[parent.split(sep).join("/")] = null;
    }
  }
  return {
    agentConfig: toAgentEntriesRecord([plan.agent.config])[plan.agent.finalId]!,
    planDigest: configuredPlanDigest(plan),
    sourceIntegrity: await configuredSourceIntegrity(plan),
    workspaceAdditions,
  };
}
