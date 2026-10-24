import { fileURLToPath } from "node:url";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
  runtimeNeedsTypeScriptLoader,
} from "../infra/runtime-worker-url.js";

/** Resolve the installed or source worker without adapters depending on core file layout. */
export function resolveWorkspaceWorkerArgv(kind: "memory" | "skills"): string[] {
  const entry =
    kind === "memory"
      ? runtimeProcessEntrypoints.workspaceMemory
      : runtimeProcessEntrypoints.workspaceSkills;
  const argv = resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(entry));
  const workerNeedsLoader = argv[0] === "--import";
  if (!workerNeedsLoader && !runtimeNeedsTypeScriptLoader(fileURLToPath(import.meta.url))) {
    return argv;
  }
  // A source host can launch a compiled worker that still imports source plugins.
  // Register this checkout's config even when the hosted workspace is elsewhere.
  const register =
    "import { register } from " +
    JSON.stringify(import.meta.resolve("tsx/esm/api")) +
    "; register({ tsconfig: " +
    JSON.stringify(fileURLToPath(new URL("../../tsconfig.json", import.meta.url))) +
    " });";
  return [
    "--import",
    `data:text/javascript,${encodeURIComponent(register)}`,
    ...(workerNeedsLoader ? argv.slice(2) : argv),
  ];
}

/** Reuse the native bounded Skill reader with host-owned per-file authorization. */
export async function readWorkspaceSkillResources(
  ...args: Parameters<typeof import("../skills/runtime/resources.js").readSkillResourceFiles>
) {
  const { readSkillResourceFiles } = await import("../skills/runtime/resources.js");
  return readSkillResourceFiles(...args);
}
