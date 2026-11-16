import type { GitHubCredentialReader } from "../../agents/github-credential-reader.js";
import type { WorkerProviderPreparedIntent } from "./preparation-identity.js";
import { readWorkerProjectPreparation } from "./preparation-identity.schema.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import type { WorkerProviderLifecycleInputOptions } from "./provider-lifecycle.types.js";
import { prepareWorkerProviderProject } from "./provider-project-preparation.js";
import { prepareRepositoryWorkerProjectSource } from "./repository-project-admission.js";
import { requireWorkerProfile } from "./service-validation.js";

export function createPreparedWorkerRefresh(
  options: Pick<
    WorkerProviderLifecycleInputOptions,
    "store" | "getConfig" | "projectNamespace" | "resolveProvider" | "registerPreparedWorkspace"
  > & {
    signal: AbortSignal;
    withLock: <T>(id: string, run: () => Promise<T>) => Promise<T>;
  },
) {
  return async (request: {
    environmentId: string;
    ownerEpoch: number;
    sessionId: string;
    expectedGeneration: number;
    intent: WorkerProviderPreparedIntent;
    assertCurrent: () => void;
    signal?: AbortSignal;
    readNativeCredential?: GitHubCredentialReader;
    retainCredentialCleanup?: (revoke: () => Promise<void>) => void;
  }) =>
    options.withLock(request.environmentId, async () => {
      const signal = request.signal
        ? AbortSignal.any([options.signal, request.signal])
        : options.signal;
      const provider = options.resolveProvider(request.intent.providerId);
      const assertCurrent = () => {
        signal.throwIfAborted();
        request.assertCurrent();
        const current = options.store.get(request.environmentId);
        if (
          !current ||
          current.state !== "ready" ||
          current.ownerEpoch !== request.ownerEpoch ||
          !current.leaseId ||
          !current.nodeDeviceId ||
          current.sharedHost !== false ||
          current.attachedSessionIds.length ||
          current.destroyRequestedAtMs !== null ||
          current.preparation?.consumedAtMs == null ||
          options.resolveProvider(current.providerId) !== provider
        ) {
          throw new Error("Prepared worker lost its claimed refresh owner");
        }
        return current;
      };
      const record = assertCurrent();
      const project = request.intent.profileSnapshot.project;
      const previous = readWorkerProjectSnapshot(record.profileSnapshot.project);
      const preparation = project?.preparation;
      if (!project || !previous || previous.baseCommit === project.baseCommit) {
        return record;
      }
      if (
        !provider?.refreshPreparedProject ||
        !options.projectNamespace ||
        !options.registerPreparedWorkspace ||
        !preparation ||
        readWorkerProjectPreparation(record.profileSnapshot.project)?.key !== preparation.key ||
        previous.key !== project.key
      ) {
        throw new Error("Provider cannot refresh this prepared workspace");
      }
      const repositorySource =
        "source" in project
          ? await prepareRepositoryWorkerProjectSource({
              expected: project,
              namespace: options.projectNamespace,
              getConfig: options.getConfig,
              assertCurrent,
              signal,
              readNativeCredential: request.readNativeCredential,
              retainCredentialCleanup: request.retainCredentialCleanup,
              knownRecipe: () => ({
                setupRecipe: preparation.setupRecipe,
                recipe: preparation.recipe,
              }),
            })
          : undefined;
      const operation = await prepareWorkerProviderProject({
        project,
        preparation,
        record,
        namespace: options.projectNamespace,
        getConfig: options.getConfig,
        requireCurrent: assertCurrent,
        signal,
        repositorySource,
      });
      try {
        await provider.refreshPreparedProject(
          {
            leaseId: record.leaseId!,
            profile: requireWorkerProfile(record.profileSnapshot.settings),
          },
          operation.project,
        );
        assertCurrent();
        const workspace = operation.getPreparedWorkspace();
        if (!workspace) {
          throw new Error("Prepared refresh returned no completed workspace");
        }
        await options.registerPreparedWorkspace({
          record,
          deviceId: record.nodeDeviceId!,
          workspace,
          signal,
          assertCurrent,
        });
        await repositorySource?.revalidate(signal);
        assertCurrent();
        // Keep the transport location recorded by the reserve; only its committed content changes.
        return await options.store.refreshPreparedProject({
          environmentId: record.environmentId,
          ownerEpoch: record.ownerEpoch,
          preparationKey: preparation.key,
          sessionId: request.sessionId,
          expectedGeneration: request.expectedGeneration,
          profileSnapshot: {
            ...record.profileSnapshot,
            project: { ...previous, preparation, baseCommit: project.baseCommit },
          },
          assertCurrent,
        });
      } finally {
        operation.close();
      }
    });
}
