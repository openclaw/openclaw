import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withProjectCheckoutLifecycle } from "./project-checkout.js";
import {
  prepareProjectRegistration,
  registerPreparedProjectRegistry,
} from "./project-registration.js";
import type { ProjectRegistryRecord } from "./project-registry.types.js";

export async function registerClonedProjectRegistry(
  input: { path: string; name: string; originUrl: string },
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> = {},
): Promise<ProjectRegistryRecord> {
  const env = cloneEnvWithPlatformSemantics(options.env ?? process.env);
  const context = captureOpenClawStateWorkerContext({ path: options.path, env });
  const prepared = await prepareProjectRegistration({ ...input, source: "cloned" });
  return await withProjectCheckoutLifecycle(
    prepared.project.repoRoot,
    { path: context.admission.databasePath, env },
    (lease) => registerPreparedProjectRegistry(prepared, lease, context),
  );
}
