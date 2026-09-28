import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { registerResolvedProject } from "./project-registration.js";
import type { ProjectRegistryRecord } from "./project-registry.kernel.js";

export function registerClonedProjectRegistry(
  input: { path: string; name: string; originUrl: string },
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> = {},
): Promise<ProjectRegistryRecord> {
  return registerResolvedProject({ ...input, source: "cloned" }, options);
}
