import { fileURLToPath } from "node:url";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";

/** Resolve the installed or source worker without adapters depending on core file layout. */
export function resolveWorkspaceWorkerArgv(kind: "memory" | "skills"): string[] {
  const entry =
    kind === "memory"
      ? runtimeProcessEntrypoints.workspaceMemory
      : runtimeProcessEntrypoints.workspaceSkills;
  const argv = resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(entry));
  if (argv[0] !== "--import") {
    return argv;
  }
  // Source workers run with the hosted workspace as cwd, outside this checkout.
  // Register the repository config explicitly so package aliases resolve there.
  const register =
    "import { register } from " +
    JSON.stringify(import.meta.resolve("tsx/esm/api")) +
    "; register({ tsconfig: " +
    JSON.stringify(fileURLToPath(new URL("../../tsconfig.json", import.meta.url))) +
    " });";
  return ["--import", `data:text/javascript,${encodeURIComponent(register)}`, ...argv.slice(2)];
}

/** Reuse the native bounded Skill reader with host-owned per-file authorization. */
export async function readWorkspaceSkillResources(
  ...args: Parameters<typeof import("../skills/runtime/resources.js").readSkillResourceFiles>
) {
  const { readSkillResourceFiles } = await import("../skills/runtime/resources.js");
  return readSkillResourceFiles(...args);
}
