import path from "node:path";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type { OpenClawStateLeaseContext } from "../state/openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  ProjectCheckoutError,
  resolveProjectCheckout,
  withProjectCheckoutLifecycle,
} from "./project-checkout.js";
import type { ProjectRegistryInsert, ProjectRegistryRecord } from "./project-registry.kernel.js";

type ProjectRegistrationInput = {
  path: string;
  name?: string;
  originUrl?: string;
  source: "registered" | "cloned";
};

type PreparedProjectRegistration = {
  requestedPath: string;
  project: ProjectRegistryInsert;
};

export async function prepareProjectRegistration(
  input: ProjectRegistrationInput,
): Promise<PreparedProjectRegistration> {
  const { path: requestedPath, name, originUrl, source } = input;
  const checkout = await resolveProjectCheckout(requestedPath);
  return {
    requestedPath,
    project: {
      displayName: name?.trim() || path.basename(checkout.repoRoot) || "Project",
      repoRoot: checkout.repoRoot,
      originUrl: originUrl ?? checkout.originUrl,
      source,
    },
  };
}

export async function registerPreparedProjectRegistry(
  prepared: PreparedProjectRegistration,
  lease: OpenClawStateLeaseContext,
  context: OpenClawStateWorkerContext,
  onRegistered?: () => void,
): Promise<ProjectRegistryRecord> {
  // A deletion can win after planning; revalidate under the original checkout owner.
  const current = await resolveProjectCheckout(prepared.project.repoRoot);
  lease.assertOwned();
  if (current.repoRoot !== prepared.project.repoRoot) {
    throw new ProjectCheckoutError(
      `project checkout changed while registering: ${prepared.requestedPath}`,
    );
  }
  const { runWithOpenClawStateLeaseWorker } =
    await import("../state/openclaw-state-worker-store.js");
  return await runWithOpenClawStateLeaseWorker(lease, context, async (scope, identity) => {
    const project = await scope.execute({
      type: "projects.insert",
      input: { project: prepared.project, lease: identity },
    });
    // Preserve acknowledgement before worker and lease finalization can fail.
    onRegistered?.();
    return project;
  });
}

export async function registerResolvedProject(
  input: ProjectRegistrationInput,
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env">,
): Promise<ProjectRegistryRecord> {
  const env = { ...(options.env ?? process.env) };
  const context = captureOpenClawStateWorkerContext({ path: options.path, env });
  const prepared = await prepareProjectRegistration(input);
  return await withProjectCheckoutLifecycle(
    prepared.project.repoRoot,
    { path: context.admission.databasePath, env },
    (lease) => registerPreparedProjectRegistry(prepared, lease, context),
  );
}
