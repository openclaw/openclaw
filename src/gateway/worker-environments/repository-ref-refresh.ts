import type { GitHubCredentialReader } from "../../agents/github-credential-reader.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import {
  AUTHENTICATED_GIT_JS,
  WORKER_REPOSITORY_GIT_ARGS,
} from "./node-worker-repository-preparation.js";
import type { WorkerSessionPlacementIdentity } from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import { matchesWorkerPlacementTarget } from "./placement-target.js";
import { prepareRepositoryGitHubIdentity } from "./repository-github-identity.js";
import type { WorkerEnvironmentService } from "./service.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";

/** Refresh only an origin tracking ref; activation and editing never wait for the fetch. */
export async function refreshRepositoryRefs(params: {
  identity: WorkerSessionPlacementIdentity & { readNativeCredential?: GitHubCredentialReader };
  placements: WorkerSessionPlacementStore;
  environments: Pick<WorkerEnvironmentService, "startTunnel">;
  resolveWorkspace: (identity: WorkerSessionPlacementIdentity) => Promise<WorkerSessionWorkspace>;
}): Promise<void> {
  const workspace = await params.resolveWorkspace(params.identity);
  if (workspace.kind !== "repository") {
    return;
  }
  const selected = await params.placements.getAsync(params.identity.sessionId);
  if (selected?.state !== "active") {
    return;
  }
  const signal = AbortSignal.any([getGatewayRestartDrainSignal(), AbortSignal.timeout(60_000)]);
  const assertCurrent = () => {
    signal.throwIfAborted();
    const current = params.placements.get(params.identity.sessionId);
    if (
      !matchesWorkerPlacementTarget(current, selected) ||
      current?.sessionKey !== params.identity.sessionKey ||
      current.agentId !== params.identity.agentId
    ) {
      throw new Error("Repository ref refresh placement changed.");
    }
  };
  const cleanup: Array<() => Promise<void>> = [];
  const processId = `repository-main-fetch-${selected.generation}`;
  let tunnel: Awaited<ReturnType<typeof params.environments.startTunnel>> | undefined;
  try {
    const github = await prepareRepositoryGitHubIdentity(params.identity.agentId, assertCurrent, {
      repositoryUrl: workspace.repository.url,
      readNativeCredential: params.identity.readNativeCredential,
      retainCredentialCleanup: (revoke) => cleanup.push(revoke),
    });
    assertCurrent();
    tunnel = await params.environments.startTunnel({
      environmentId: selected.environmentId,
      ownerEpoch: selected.activeOwnerEpoch,
      authorize: assertCurrent,
    });
    assertCurrent();
    const owned = tunnel;
    await github.start(async () => {
      let result = await owned.runWorkspaceCommand({
        argv: [
          "node",
          "-e",
          AUTHENTICATED_GIT_JS,
          "--",
          ...WORKER_REPOSITORY_GIT_ARGS,
          "fetch",
          "--no-tags",
          "--no-auto-maintenance",
          "--no-write-fetch-head",
          "--no-recurse-submodules",
          "--",
          workspace.repository.url,
          "+refs/heads/main:refs/remotes/origin/main",
        ],
        input: JSON.stringify({
          origin: workspace.repository.url,
          token: github.token,
          disableLazyFetch: true,
        }),
        process: { action: "start", processId },
        transportRetry: "never",
        assertCurrent,
      });
      while (result.code === null && result.signal === null && !result.killed) {
        await sleepWithAbort(250, signal);
        assertCurrent();
        result = await owned.runWorkspaceCommand({
          argv: ["openclaw-internal-workspace-process"],
          process: { action: "status", processId },
          transportRetry: "never",
          assertCurrent,
        });
      }
      if (result.code !== 0) {
        throw new Error("Repository main ref refresh failed.");
      }
    });
  } finally {
    await tunnel
      ?.runWorkspaceCommand({
        argv: ["openclaw-internal-workspace-process"],
        process: { action: "stop", processId },
        transportRetry: "never",
      })
      .catch(() => undefined);
    for (const revoke of cleanup) {
      await revoke();
    }
  }
}
