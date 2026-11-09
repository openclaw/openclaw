// Install provider transport fixtures before importing the native publication owners.
// oxfmt-ignore
import { commandResult, githubPublicationTestMocks, installGitHubPublicationTestHarness, root } from "./github-publication.test-support.js";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { runNodeWorkerWorkspaceTransfer } from "../node-host/node-worker-transfer-client.js";
import type { runCommandBuffered } from "../process/exec.js";
import { NODE_WORKSPACE_EMPTY_MANIFEST_REF } from "../worker/node-workspace-transfer-protocol.js";
import { registerPublicationCredentialFixture } from "./github-publication-credential.test-helpers.js";
import { GitHubPublicationRequesterUnavailableError } from "./github-publication-failure.js";
import {
  createRequesterPublicationFixture,
  publicationGuestEmail as email,
} from "./github-publication-requester.test-support.js";
import { readRepositoryGitHubPublicationFixture as readRepositoryGitHubPublication } from "./github-publication-store.test-support.js";
import type { PrepareRepositoryPublicationIntegration } from "./repository-publication-integration.js";
import { hashWorkerCredential } from "./worker-environments/credential.js";
import { createNodeWorkerBundleTestNode } from "./worker-environments/node-worker-bundle.test-support.js";
import { prepareNodeWorkerPublicationIntegration } from "./worker-environments/node-worker-publication-transfer.js";
import { createNodeWorkspaceTransferCommand } from "./worker-environments/node-workspace-transfer-command.js";
import { createNodeWorkspaceTransferService } from "./worker-environments/node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./worker-environments/node-workspace-transfer.test-support.js";
import {
  createDispatchEnvironmentFixtures,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { writePlacementEnvironmentFixture } from "./worker-environments/placement-test-fixtures.js";
import { createRepositoryPublicationPreparation } from "./worker-environments/repository-publication-preparation.js";
import { createWorkerEnvironmentStore } from "./worker-environments/store.js";
import { WorkerTunnelOwnerDisconnectedError } from "./worker-environments/tunnel-contract.js";
import { createWorkerTurnTunnel } from "./worker-environments/worker-turn-launcher.test-support.js";

const mocks = githubPublicationTestMocks();
const checkpoint = vi.hoisted(() => vi.fn());
// mock-isolation: Checkpoint capture is fixture-owned; requester/source/receipt and native transfer owners are real.
vi.mock("./worker-environments/session-repository-checkpoints.js", () => ({
  withSessionRepositoryPublicationCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));
const fixture = createRequesterPublicationFixture.bind(undefined, checkpoint);
const request = (f: Awaited<ReturnType<typeof fixture>>, key: string) =>
  f.coordinator.requestForSessionV2(f.request(key, f.guest));

/** Real authority, receipts, Git and HTTP; checkpoint input, publisher and node enrollment remain synthetic. */
async function createNativePublicationTransport(
  f: Awaited<ReturnType<typeof createRequesterPublicationFixture>>,
  events: string[],
) {
  const repository = f.repository;
  if (!repository) {
    throw new Error("Native publication proof requires a repository fixture");
  }
  const environmentId = "combined-publication-worker";
  const ownerEpoch = 1;
  const environments = await createWorkerEnvironmentStore({ database: f.database });
  writePlacementEnvironmentFixture(f.database, {
    ...createDispatchEnvironmentFixtures().attached,
    environmentId,
    ownerEpoch,
    attachedSessionIds: [f.session.sessionId],
  });
  await environments.renewCredential({
    environmentId,
    expectedOwnerEpoch: ownerEpoch,
    credentialHash: hashWorkerCredential("synthetic-worker-transfer"),
    sessionId: f.session.sessionId,
    rpcSetVersion: 1,
    expiresAtMs: Date.now() + 60_000,
  });
  await seedActivePlacement(f.placements, { environmentId, ownerEpoch });
  const node = createNodeWorkerBundleTestNode({ workerHost: { publicationIntegration: 1 } });
  const service = createNodeWorkspaceTransferService({
    temporaryRoot: nodePath.join(root, "combined-transfers"),
    getOwner: (id) => environments.getTransferOwner(id),
  });
  const observed = {
    nativeExecutions: 0,
    httpRequests: 0,
    gitFetches: 0,
    physicalCas: 0,
    get admissions() {
      return events.filter((event) => event === "integration-admitted").length;
    },
  };
  const authorize = service.authorize.bind(service);
  vi.spyOn(service, "authorize").mockImplementation((input) => {
    observed.httpRequests++;
    return authorize(input);
  });
  const server = await startNodeWorkspaceTransferTestServer(service);
  onTestFinished(async () => {
    await server.close();
    await service.closeAll();
    await environments.close();
  });
  repository.git(["update-ref", "refs/heads/main", repository.baseCommit]);
  repository.git(["update-ref", "refs/heads/topic", repository.baseCommit]);
  const ref = "refs/heads/" + repository.workspace.branch;
  const readRef = () => repository.git(["for-each-ref", "--format=%(objectname)", ref]);
  const provider = mocks.runCommand.getMockImplementation()!;
  const native = await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
  let unavailable = true;
  // Same external-I/O seam as the canonical publication Git fixture: exact synthetic URL only,
  // file protocol only. All Git commands, object writes and compare-and-swap ref effects are real.
  const transport: typeof runCommandBuffered = async (argv, options) => {
    if (argv[0] === "git") {
      if (argv.includes("fetch")) {
        observed.gitFetches++;
      }
      return native.runCommandBuffered(
        argv.map((arg) =>
          arg === "https://github.com/owner/repository.git"
            ? pathToFileURL(repository.remote).href
            : arg,
        ),
        { ...options, env: { ...options?.env, GIT_ALLOW_PROTOCOL: "file" } },
      );
    }
    if (argv[0] !== "gh") {
      throw new Error("Unexpected combined fixture command");
    }
    if (unavailable && argv.some((arg) => arg.endsWith("/git/blobs"))) {
      return {
        ...commandResult("", 1),
        stderr: Buffer.from("synthetic-provider-canary (HTTP 503)"),
      };
    }
    if (argv.includes("graphql")) {
      if (typeof options?.input !== "string") {
        throw new Error("Expected fixed CAS payload");
      }
      const body = JSON.parse(options.input);
      const update = body.variables.input.refUpdates[0];
      expect(update.name).toBe(ref);
      expect(update.force).toBe(false);
      expect(update.beforeOid).toBe(readRef() || "0".repeat(40));
      repository.git(["update-ref", ref, update.afterOid, update.beforeOid]);
      observed.physicalCas++;
    }
    return provider(argv, options);
  };
  mocks.runCommand.mockImplementation(transport);
  const integrate = async (input: Parameters<PrepareRepositoryPublicationIntegration>[1]) => {
    input.assertCurrent();
    const isCurrent = () => {
      const placement = f.placements.get(f.session.sessionId);
      return (
        placement?.state === "active" &&
        placement.environmentId === environmentId &&
        placement.activeOwnerEpoch === ownerEpoch &&
        placement.agentId === "main" &&
        placement.sessionKey === f.session.sessionKey
      );
    };
    await service.prepareRepository({
      environmentId,
      ownerEpoch,
      sessionId: f.session.sessionId,
      baseCommit: repository.baseCommit,
      baseManifestRef: NODE_WORKSPACE_EMPTY_MANIFEST_REF,
      isAuthorized: isCurrent,
      authorize: input.assertCurrent,
    });
    const transfer = createNodeWorkspaceTransferCommand(async (command) => {
      command.assertCurrent?.();
      if (!command.transfer) {
        throw new Error("Expected native publication transfer");
      }
      observed.nativeExecutions++;
      const stdout = await runNodeWorkerWorkspaceTransfer({
        gatewayUrl: server.gatewayUrl,
        environmentId,
        workspaceDir: repository.remote,
        manifestHome: nodePath.join(root, "combined-node-home"),
        transfer: command.transfer,
        signal: command.signal,
        assertCurrent: command.assertCurrent,
      });
      return {
        code: 0,
        termination: "exit",
        signal: null,
        killed: false,
        stdout,
        stderr: "",
        workspaceDir: repository.remote,
      };
    });
    return prepareNodeWorkerPublicationIntegration(
      {
        environmentId,
        signal: f.guest.signal,
        workspaceTransfer: service,
        supportsIntegration: async () => {
          input.assertCurrent();
          return isCurrent() && node.workerHost.publicationIntegration === 1;
        },
        transfer,
      },
      input,
    );
  };
  const tunnel = createWorkerTurnTunnel({
    environmentId,
    ownerEpoch,
    launchTurn: async () => {
      throw new Error("Publication must not launch a model turn");
    },
    reconcileWorkspace: async () => {
      throw new Error("Unexpected editing-workspace reconciliation");
    },
    integratePublication: integrate,
  });
  let disconnected = false;
  const preparation = createRepositoryPublicationPreparation({
    placements: f.placements,
    getConfig: () => f.config,
    ensurePlacement: async () => {
      throw new Error("Unexpected worker provisioning");
    },
    resolveDevicePlacementRequirement: async () => {
      throw new Error("Unexpected device selection");
    },
    environments: {
      get: (id) => {
        const current = environments.get(id);
        return (
          current && {
            ...current,
            desktopAvailable: false,
            desktopApps: [],
            tunnelStatus: "connected" as const,
          }
        );
      },
      startTunnel: async (input) => {
        input.authorize?.();
        if (disconnected) {
          disconnected = false;
          throw new WorkerTunnelOwnerDisconnectedError();
        }
        return tunnel;
      },
      inspectTurnLease: async () => {
        throw new Error("Fixture has no retained compute lease");
      },
    },
    waitForNode: async (input) => {
      input.assertCurrent();
      expect(node.workerHost.publicationIntegration).toBe(1);
    },
    reconcileActive: async (id) => {
      f.guest.assertCurrent();
      expect(environments.get(id)?.ownerEpoch).toBe(ownerEpoch);
    },
  });
  mocks.prepareRepositoryIntegration.mockImplementation((identity, input) => {
    disconnected = true;
    return preparation(identity, input);
  });
  return {
    observed,
    readRef,
    ref,
    recoverProvider: () => {
      unavailable = false;
    },
    revokeCustody: () => environments.revokeEnvironmentCredential(environmentId),
  };
}

describe("combined native publication proof", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: email,
    sandbox: "required",
    realWorktree: true,
  });
  it.each([
    "allowed",
    "revoked",
    "different-requester",
    "placement-moving",
    "custody-revoked",
  ] as const)(
    "retains the accepted request across a pre-effect 503 and coordinator restart: %s",
    async (scenario) => {
      const f = await fixture("repository", undefined, { requestedRef: "topic" });
      const repository = f.repository!;
      const events: string[] = [];
      const canary = registerPublicationCredentialFixture(f, events);
      const native = await createNativePublicationTransport(f, events);
      const beforeRef = native.readRef();
      expect(beforeRef).toBe("");
      const first = await request(f, "combined-retry");
      expect(first).toMatchObject({
        status: "failed",
        code: "unavailable",
        nextAction: expect.stringContaining("HTTP 503"),
      });
      const accepted = readRepositoryGitHubPublication(first.requestId)!;
      expect(accepted).toMatchObject({
        base_branch: "main",
        checkpoint_ref: repository.first.ref,
        last_effect: null,
      });
      expect(native.readRef()).toBe(beforeRef);
      expect(repository.runtime.effects).toEqual([]);
      expect(native.observed.nativeExecutions).toBe(1);
      expect(native.observed.gitFetches).toBe(2);
      expect(native.observed.httpRequests).toBeGreaterThan(0);
      expect(native.observed.admissions).toBe(1);
      const beforeRetry = { ...native.observed };
      native.recoverProvider();
      if (scenario === "revoked") {
        await f.revoke();
      } else if (scenario === "placement-moving") {
        const active = await f.placements.getAsync(f.session.sessionId);
        if (active?.state !== "active") {
          throw new Error("Expected an admitted active placement");
        }
        await f.placements.beginPlacementMove({
          sessionId: f.session.sessionId,
          source: {
            generation: active.generation,
            environmentId: active.environmentId,
            ownerEpoch: active.activeOwnerEpoch,
          },
          target: { kind: "profile", profileId: "other-worker" },
        });
      } else if (scenario === "custody-revoked") {
        await native.revokeCustody();
      }
      const restarted = f.restart();
      const retry = restarted.requestForSessionV2(
        f.request("combined-retry", scenario === "different-requester" ? f.maintainer : f.guest),
      );
      if (scenario === "allowed") {
        await expect(retry).resolves.toMatchObject({
          status: "published",
          requestId: first.requestId,
        });
        expect(native.observed.physicalCas).toBe(1);
        expect(repository.runtime.effects).toEqual(["push", "pull_request"]);
        expect(repository.runtime.pr?.baseRef).toBe("main");
        expect(native.readRef()).toBe(repository.runtime.head);
        expect(repository.git(["rev-parse", native.ref + "^{tree}"])).toBe(
          repository.first.workspaceTree,
        );
        expect(repository.git(["show", native.ref + ":counter.txt"])).toBe("accepted first");
        expect(repository.git(["rev-parse", native.ref + "^2"])).toBe(repository.baseCommit);
        expect(repository.git(["rev-parse", native.ref + "^1^1"])).toBe(repository.baseCommit);
        expect(repository.git(["rev-parse", native.ref + "^1^{tree}"])).toBe(
          repository.first.workspaceTree,
        );
        expect(
          repository.git(["rev-list", "--parents", "-n", "1", native.ref]).split(" "),
        ).toHaveLength(3);
        expect(repository.git(["rev-parse", "refs/heads/main"])).toBe(repository.baseCommit);
        expect(repository.git(["rev-parse", "refs/heads/topic"])).toBe(repository.baseCommit);
        await restarted.resumeSessionRequests();
        expect(native.observed.physicalCas).toBe(1);
      } else {
        if (scenario === "custody-revoked") {
          await expect(retry).resolves.toMatchObject({
            status: "failed",
            code: "workspace_changed",
            requestId: first.requestId,
          });
        } else if (scenario === "placement-moving") {
          await expect(retry).rejects.toThrow("The repository checkpoint is busy");
        } else if (scenario === "different-requester") {
          await expect(retry).rejects.toThrow("different requester");
        } else {
          await expect(retry).rejects.toBeInstanceOf(GitHubPublicationRequesterUnavailableError);
        }
        expect(native.readRef()).toBe(beforeRef);
        expect(native.observed.physicalCas).toBe(0);
        expect(native.observed.nativeExecutions).toBe(beforeRetry.nativeExecutions);
        expect(native.observed.gitFetches).toBe(beforeRetry.gitFetches);
        expect(native.observed.httpRequests).toBe(beforeRetry.httpRequests);
        expect(repository.runtime.effects).toEqual([]);
        // A pending move blocks effects after same-key reopening; it retains recoverable work, not a terminal failure.
        expect(readRepositoryGitHubPublication(first.requestId)?.status).toBe(
          scenario === "placement-moving" ? "requested" : "failed",
        );
      }
      const settled = readRepositoryGitHubPublication(first.requestId)!;
      expect(settled).toMatchObject({
        request_id: accepted.request_id,
        request_digest: accepted.request_digest,
        checkpoint_ref: accepted.checkpoint_ref,
        checkpoint_digest: accepted.checkpoint_digest,
        previous_head_commit: accepted.previous_head_commit,
        workspace_tree: accepted.workspace_tree,
      });
      const trace = JSON.stringify({
        scenario,
        beforeRef,
        afterRef: native.readRef(),
        requestId: settled.request_id,
        checkpoint: settled.checkpoint_ref,
        checkpointDigest: settled.checkpoint_digest,
        digest: settled.request_digest,
        baseBranch: settled.base_branch,
        workspaceTree: settled.workspace_tree,
        afterFirstFailure: beforeRetry,
        status: settled.status,
        intentionalPending: scenario === "placement-moving",
        effects: repository.runtime.effects,
        ...native.observed,
      });
      expect(trace).not.toContain(canary);
      expect(trace).not.toContain("synthetic-provider-canary");
      expect(JSON.stringify(first)).not.toContain("synthetic-provider-canary");
      console.info("PUBLICATION_BOUNDARY_TRACE " + trace);
    },
  );
});
