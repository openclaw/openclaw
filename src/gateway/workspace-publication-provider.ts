import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { getPluginValueInstance, runPluginCleanup } from "../plugins/plugin-instance-scope.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createRepositoryPublicationDiscovery } from "./github-publication-discovery.js";
import {
  RepositoryPublicationFailureError,
  RepositoryPublicationProviderUnavailableError,
} from "./github-publication-errors.js";
import type { RepositoryPublicationTranscriptRuntime } from "./github-publication-transcript.js";
import type { GitHubPublicationCoordinator } from "./github-publication.js";
import type {
  RepositoryPublicationProvider,
  RepositoryPublicationApi,
} from "./repository-publication-contract.js";
import type {
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./worker-environments/placement-store.js";

/** The Gateway retains accepted transaction custody independently from the current vendor service. */
export function createWorkspacePublicationHost(params: {
  placements: WorkerSessionPlacementStore;
  loadSessionRuntime: () => Promise<RepositoryPublicationTranscriptRuntime>;
  managedByPlacement: boolean;
  getCommittedRuntimeConfig: () => OpenClawConfig;
  scheduler: GatewayScheduler;
  warn: (message: string) => void;
}) {
  const context = captureOpenClawStateWorkerContext();
  const signal = params.scheduler.signal;
  type Registration = {
    provider: RepositoryPublicationProvider;
    signal: AbortSignal;
    api?: RepositoryPublicationApi;
  };
  let current: Registration | undefined;
  const requireProvider = () => {
    signal.throwIfAborted();
    if (!current || current.signal.aborted) {
      throw new RepositoryPublicationProviderUnavailableError();
    }
    current.provider.assertCurrent();
    return current.provider;
  };
  const discovery = createRepositoryPublicationDiscovery({
    scheduler: params.scheduler,
    getProvider: requireProvider,
  });
  const formatReport = (result: SessionGitHubPublicationResult) =>
    current && !current.signal.aborted
      ? current.provider.formatReport(result)
      : {
          responseId: `github-publication:${result.requestId}`,
          text:
            result.status === "published"
              ? `Published ${result.repository} branch ${result.branch}: ${result.url}`
              : result.status === "failed"
                ? `Publication failed: ${result.message} ${result.nextAction}`
                : result.message,
        };
  const provider: RepositoryPublicationProvider = {
    id: "repository-publication",
    supportsOrigin: (originUrl) => requireProvider().supportsOrigin(originUrl),
    assertCurrent: () => {
      requireProvider();
    },
    formatReport,
    preparePublisher: (...args) => requireProvider().preparePublisher(...args),
    bindPersonal: (...args) => requireProvider().bindPersonal(...args),
    readPersonalSelection: (...args) => requireProvider().readPersonalSelection(...args),
    readOptionsIdentity: (...args) => requireProvider().readOptionsIdentity(...args),
    preparePersonalAccountStatus: (...args) =>
      requireProvider().preparePersonalAccountStatus(...args),
    isPublicationSuperseded: (...args) => requireProvider().isPublicationSuperseded(...args),
    performPullRequestAction: (...args) => requireProvider().performPullRequestAction(...args),
    inspectPullRequest: (...args) => requireProvider().inspectPullRequest(...args),
    prepareBoundPublication: (...args) => requireProvider().prepareBoundPublication(...args),
    prepareTarget: (...args) => requireProvider().prepareTarget(...args),
    preparePublishedTarget: (...args) => requireProvider().preparePublishedTarget(...args),
    readBase: (...args) => requireProvider().readBase(...args),
    observeBranch: (...args) => requireProvider().observeBranch(...args),
    findPullRequest: (...args) => requireProvider().findPullRequest(...args),
    createPullRequest: (...args) => requireProvider().createPullRequest(...args),
    reconcile: (...args) => requireProvider().reconcile(...args),
    formatContent: (...args) => requireProvider().formatContent(...args),
    prepareChangeGuard: (...args) => requireProvider().prepareChangeGuard(...args),
    executeRepository: (...args) => requireProvider().executeRepository(...args),
    resolveGitAuthor: (agentId) =>
      current && !current.signal.aborted ? current.provider.resolveGitAuthor?.(agentId) : undefined,
    isDefinitiveFailure: (error) =>
      error instanceof RepositoryPublicationFailureError ||
      Boolean(current && !current.signal.aborted && current.provider.isDefinitiveFailure(error)),
    resolveFailure: (error) =>
      error instanceof RepositoryPublicationFailureError && (!current || current.signal.aborted)
        ? error.failure
        : requireProvider().resolveFailure(error),
  };
  let coordinator: GitHubPublicationCoordinator | undefined;
  const runtime = import("./github-publication-runtime.js").then(
    ({ createGitHubPublicationRuntime }) => {
      signal.throwIfAborted();
      context.admission.assertCurrent();
      const created = createGitHubPublicationRuntime({
        ...params,
        context,
        signal,
        provider,
        formatReport,
      });
      coordinator = created.coordinator;
      return created;
    },
  );
  const ready = runtime.then((value) => value.ready);
  void ready.catch(() => {});
  signal.addEventListener(
    "abort",
    () => {
      current = undefined;
      void runtime.then((value) => value.close()).catch(() => {});
    },
    { once: true },
  );
  if (!params.managedByPlacement) {
    params.scheduler.schedule({
      id: "repository-publication-recovery",
      delayMs: 0,
      everyMs: 60_000,
      run: async () => {
        try {
          await (await runtime).reconcilePublications(() => signal.aborted);
        } catch (error) {
          if (!signal.aborted) {
            params.warn(
              `Repository publication recovery deferred: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      },
    });
  }
  return {
    /** Look up this exact installed owner; retained API operations reject replacement. */
    readApi(): RepositoryPublicationApi | undefined {
      const selected = current;
      if (signal.aborted || !selected || selected.signal.aborted || !selected.api) {
        return undefined;
      }
      selected.provider.assertCurrent();
      return selected.api;
    },
    /** A bound tool may use this provider's host RPCs, never a later same-id replacement. */
    captureProviderAuthority(pluginId: string): (() => void) | undefined {
      const selected = current;
      if (!selected || selected.provider.id !== pluginId || selected.signal.aborted) {
        return undefined;
      }
      return () => {
        signal.throwIfAborted();
        if (current !== selected) {
          throw new RepositoryPublicationProviderUnavailableError();
        }
        selected.signal.throwIfAborted();
        selected.provider.assertCurrent();
      };
    },
    get coordinator() {
      return coordinator;
    },
    ready,
    close: async () => {
      await (await runtime).close();
    },
    async install(next: RepositoryPublicationProvider, ownerSignal: AbortSignal) {
      signal.throwIfAborted();
      ownerSignal.throwIfAborted();
      next.assertCurrent();
      if (current) {
        throw new Error("A repository publisher is already installed.");
      }
      const registration: Registration = { provider: next, signal: ownerSignal };
      current = registration;
      discovery.clear();
      let stopIdentityChanges: (() => void) | undefined;
      const instance = getPluginValueInstance(next);
      let subscriptionStopped = false;
      let removeInstanceCleanup: (() => void) | undefined;
      const stopIdentitySubscription = () => {
        if (subscriptionStopped) {
          return;
        }
        runPluginCleanup(next, () => stopIdentityChanges?.());
        subscriptionStopped = true;
        const remove = removeInstanceCleanup;
        removeInstanceCleanup = undefined;
        remove?.();
      };
      const uninstall = () => {
        ownerSignal.removeEventListener("abort", uninstall);
        if (current === registration) {
          current = undefined;
          discovery.clear();
        }
        // An abort listener has no cleanup lease. Retirement runs the same
        // unsubscribe in its registered owner cleanup; a live service stops now.
        if (!instance?.lifecycle.signal.aborted) {
          stopIdentitySubscription();
        }
      };
      try {
        stopIdentityChanges = next.subscribeWorkerIdentityChanges?.(() => discovery.invalidate());
        removeInstanceCleanup = instance?.lifecycle.onDispose(stopIdentitySubscription);
        ownerSignal.addEventListener("abort", uninstall, { once: true });
        await ready;
        ownerSignal.throwIfAborted();
        next.assertCurrent();
        const owner = (await runtime).coordinator;
        const guard = () => {
          signal.throwIfAborted();
          if (current !== registration || ownerSignal.aborted) {
            throw new RepositoryPublicationProviderUnavailableError();
          }
          next.assertCurrent();
        };
        const api: RepositoryPublicationApi = {
          async readOptionsIdentity(input) {
            guard();
            const result = await next.readOptionsIdentity({
              ...input,
              assertCurrent() {
                guard();
                input.assertCurrent();
              },
            });
            guard();
            input.assertCurrent();
            return result;
          },
          async preparePersonalAccountStatus(action) {
            guard();
            const prepared = await next.preparePersonalAccountStatus(action);
            guard();
            return {
              status: prepared.status,
              assertCurrent() {
                guard();
                prepared.assertCurrent();
              },
            };
          },
          async isPublicationSuperseded(snapshot, readPublished) {
            guard();
            const result = await next.isPublicationSuperseded(snapshot, async () => {
              guard();
              const history = await readPublished();
              guard();
              return history;
            });
            guard();
            return result;
          },
          supportsOrigin: (originUrl) => {
            guard();
            return next.supportsOrigin(originUrl);
          },
          performPullRequestAction: async (input) => {
            guard();
            const result = await (
              await runtime
            ).performPullRequestAction({
              ...input,
              assertCurrent() {
                guard();
                input.assertCurrent();
              },
            });
            guard();
            input.assertCurrent();
            return result;
          },
          inspectPullRequest: async (...args) => {
            guard();
            return await (await runtime).inspectPullRequest(...args);
          },
          preparePullRequest: (...args) => {
            guard();
            return owner.preparePullRequest(...args);
          },
          refreshBase: (...args) => {
            guard();
            return owner.refreshBase(...args);
          },
          requestForSessionV2: (...args) => {
            guard();
            return owner.requestForSessionV2(...args);
          },
          requestPersonalForSessionV2: (...args) => {
            guard();
            return owner.requestPersonalForSessionV2(...args);
          },
          confirmPersonalV2: (...args) => {
            guard();
            return owner.confirmPersonalV2(...args);
          },
          preparePersonalStatus: (...args) => {
            guard();
            return owner.preparePersonalStatus(...args);
          },
          personalStatusAsync: (...args) => {
            guard();
            return owner.personalStatusAsync(...args);
          },
          personalPending: (...args) => {
            guard();
            return owner.personalPending(...args);
          },
          sharedStatus: (...args) => {
            guard();
            return owner.sharedStatus(...args);
          },
          latestShared: (...args) => {
            guard();
            return owner.latestShared(...args);
          },
          latestPublishedShared: (...args) => {
            guard();
            return owner.latestPublishedShared(...args);
          },
        };
        guard();
        registration.api = api;
        return {
          api,
          uninstall: () => {
            ownerSignal.removeEventListener("abort", uninstall);
            uninstall();
          },
        };
      } catch (error) {
        ownerSignal.removeEventListener("abort", uninstall);
        uninstall();
        throw error;
      }
    },
    bindSessionRowProjection: discovery.bindProjection,
    readWorkerPublicationFact: (session: Parameters<typeof discovery.read>[0]) =>
      discovery.read(session),
    resolveGitAuthor: (agentId: string) => provider.resolveGitAuthor?.(agentId),
    prepareAcceptedWorkspacePublication: async (claim: WorkerSessionTurnClaim) => {
      await (await runtime).prepareAcceptedWorkspacePublication(claim);
    },
    publishAcceptedWorkspace: async (claim: WorkerSessionTurnClaim) => {
      await (await runtime).publishAcceptedWorkspace(claim);
    },
    reconcilePublications: async (isStopping?: () => boolean) => {
      await (await runtime).reconcilePublications(isStopping);
    },
  };
}
export type WorkspacePublicationHost = ReturnType<typeof createWorkspacePublicationHost>;
