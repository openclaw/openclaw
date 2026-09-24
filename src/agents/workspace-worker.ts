import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";

/** Resolve the installed or source worker without adapters depending on core file layout. */
export function resolveWorkspaceWorkerArgv(kind: "memory" | "skills"): string[] {
  const entry =
    kind === "memory"
      ? runtimeProcessEntrypoints.workspaceMemory
      : runtimeProcessEntrypoints.workspaceSkills;
  return resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(entry));
}

/** Reuse the native bounded Skill reader with host-owned per-file authorization. */
export async function readWorkspaceSkillResources(
  ...args: Parameters<typeof import("../skills/runtime/resources.js").readSkillResourceFiles>
) {
  const { readSkillResourceFiles } = await import("../skills/runtime/resources.js");
  return readSkillResourceFiles(...args);
}
