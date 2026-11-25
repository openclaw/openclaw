import { fileURLToPath } from "node:url";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeArgs,
  resolveRuntimeWorkerUrl,
  runtimeNeedsTypeScriptLoader,
} from "../infra/runtime-worker-url.js";

/** Resolve the installed or source worker without adapters depending on core file layout. */
export function resolveWorkspaceWorkerUrl(kind: "memory" | "skills"): URL {
  return resolveRuntimeWorkerUrl(
    kind === "memory"
      ? runtimeProcessEntrypoints.workspaceMemory
      : runtimeProcessEntrypoints.workspaceSkills,
  );
}

/** Preserve the source host's config when a worker imports source plugins. */
export function resolveWorkspaceWorkerExecArgv(kind: "memory" | "skills"): string[] {
  if (
    !runtimeNeedsTypeScriptLoader(fileURLToPath(resolveWorkspaceWorkerUrl(kind))) &&
    !runtimeNeedsTypeScriptLoader(fileURLToPath(import.meta.url))
  ) {
    return resolveRuntimeArgs();
  }
  const register =
    "import { register } from " +
    JSON.stringify(import.meta.resolve("tsx/esm/api")) +
    "; register({ tsconfig: " +
    JSON.stringify(fileURLToPath(new URL("../../tsconfig.json", import.meta.url))) +
    " });";
  return ["--import", `data:text/javascript,${encodeURIComponent(register)}`];
}

export function resolveWorkspaceWorkerArgv(kind: "memory" | "skills"): string[] {
  return [...resolveWorkspaceWorkerExecArgv(kind), fileURLToPath(resolveWorkspaceWorkerUrl(kind))];
}

/** Reuse the native bounded Skill reader with host-owned per-file authorization. */
export async function readWorkspaceSkillResources(
  ...args: Parameters<typeof import("../skills/runtime/resources.js").readSkillResourceFiles>
) {
  const { readSkillResourceFiles } = await import("../skills/runtime/resources.js");
  return readSkillResourceFiles(...args);
}
