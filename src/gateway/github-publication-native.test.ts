// Install provider transport fixtures before importing the native publication owners.
// oxfmt-ignore
import { commandResult, githubPublicationTestMocks, installGitHubPublicationTestHarness, root, SESSION_ID, SESSION_KEY } from "./github-publication.test-support.js";
import fs from "node:fs/promises";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { notifyManagedGitHubProfileChanged } from "../agents/github-tool-identity-lifecycle.js";
import { GitHubIdentityError } from "../agents/github-tool-identity.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { runNodeWorkerWorkspaceTransfer } from "../node-host/node-worker-transfer-client.js";
import type { runCommandBuffered } from "../process/exec.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { NODE_WORKSPACE_EMPTY_MANIFEST_REF } from "../worker/node-workspace-transfer-protocol.js";
import {
  createPersonalPublicationFixture,
  personalPublicationAccount,
  personalPublicationRequest,
  preparePersonalPublicationFixtureAction,
} from "./github-personal-publication.test-support.js";
import { registerPublicationCredentialFixture } from "./github-publication-credential.test-helpers.js";
import { prepareGitHubPublicationWorkerIdentity } from "./github-publication-execution-identity.js";
import { GitHubPublicationRequesterUnavailableError } from "./github-publication-failure.js";
import {
  createRequesterPublicationFixture,
  publicationGuestEmail as email,
} from "./github-publication-requester.test-support.js";
import { readRepositoryGitHubPublicationFixture as readRepositoryGitHubPublication } from "./github-publication-store.test-support.js";
import { createRepositoryPublicationFixture } from "./github-repository-publication.test-support.js";
import type { PrepareRepositoryPublicationIntegration } from "./repository-publication-integration.js";
import { hashWorkerCredential } from "./worker-environments/credential.js";
import { createNodeWorkerBundleTestNode } from "./worker-environments/node-worker-bundle.test-support.js";
import { prepareNodeWorkerPublicationIntegration } from "./worker-environments/node-worker-publication-transfer.js";
import { createNodeWorkspaceTransferCommand } from "./worker-environments/node-workspace-transfer-command.js";
import { createNodeWorkspaceTransferService } from "./worker-environments/node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./worker-environments/node-workspace-transfer.test-support.js";
import {
  createDispatchEnvironmentFixtures,
  REQUEST,
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
  f: Pick<
    Awaited<ReturnType<typeof createRequesterPublicationFixture>>,
    "repository" | "database" | "session" | "placements" | "config"
  > & {
    guest: { signal: AbortSignal; assertCurrent: () => void };
  },
  events: string[],
  inspect?: {
    worker: (value: string) => void;
    publisher: (env: NodeJS.ProcessEnv | undefined, argv: string[]) => void;
  },
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
  let seededPlacement = await f.placements.startDispatch({ ...REQUEST, ...f.session });
  for (const [from, to, patch] of [
    ["requested", "provisioning", { environmentId }],
    ["provisioning", "syncing", { workerBundleHash: "a".repeat(64) }],
    [
      "syncing",
      "starting",
      {
        workspaceBaseManifestRef: NODE_WORKSPACE_EMPTY_MANIFEST_REF,
        remoteWorkspaceDir: repository.remote,
      },
    ],
    ["starting", "active", { activeOwnerEpoch: ownerEpoch }],
  ] as const) {
    seededPlacement = await f.placements.transition({
      sessionId: f.session.sessionId,
      from,
      to,
      expectedGeneration: seededPlacement.generation,
      patch,
    });
  }
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
      inspect?.worker(JSON.stringify({ argv, options }));
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
    inspect?.publisher(options?.env, argv);
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
      inspect?.worker(JSON.stringify(command));
      if (inspect) {
        const files = [
          nodePath.join(input.snapshotRoot, "snapshot.json"),
          ...(await fs.readdir(nodePath.join(input.snapshotRoot, "blobs"))).map((name) =>
            nodePath.join(input.snapshotRoot, "blobs", name),
          ),
          ...(input.history?.gitPackPath ? [input.history.gitPackPath] : []),
        ];
        for (const file of files) {
          inspect.worker((await fs.readFile(file)).toString("utf8"));
        }
      }
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
    "read-throttled",
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
      if (scenario === "read-throttled") {
        native.recoverProvider();
        const provider = mocks.runCommand.getMockImplementation()!;
        let repositoryReads = 0;
        mocks.runCommand.mockImplementation((argv, options) => {
          // Target selection and publisher observation succeed; the execution-reader
          // probe is throttled before any native integration or publication effect.
          if (argv.includes("repos/owner/repository") && ++repositoryReads === 3) {
            return {
              ...commandResult("", 1),
              stderr: Buffer.from("synthetic secondary rate limit (HTTP 403)"),
            };
          }
          return provider(argv, options);
        });
      }
      const beforeRef = native.readRef();
      expect(beforeRef).toBe("");
      const first = await request(f, "combined-retry");
      expect(first).toMatchObject({
        status: "failed",
        code: "unavailable",
        nextAction: expect.stringContaining(
          scenario === "read-throttled" ? "HTTP 403" : "HTTP 503",
        ),
      });
      const accepted = readRepositoryGitHubPublication(first.requestId)!;
      expect(accepted).toMatchObject({
        base_branch: "main",
        checkpoint_ref: repository.first.ref,
        last_effect: null,
      });
      expect(native.readRef()).toBe(beforeRef);
      expect(repository.runtime.effects).toEqual([]);
      const integrated = scenario === "read-throttled" ? 0 : 1;
      expect(native.observed.nativeExecutions).toBe(integrated);
      expect(native.observed.gitFetches).toBe(integrated * 2);
      if (integrated) {
        expect(native.observed.httpRequests).toBeGreaterThan(0);
      } else {
        expect(native.observed.httpRequests).toBe(0);
      }
      expect(native.observed.admissions).toBe(integrated);
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
      if (scenario === "allowed" || scenario === "read-throttled") {
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

describe("personal publisher credential custody", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "alice@example.test",
    sandbox: "required",
    realWorktree: true,
  });
  it.each([
    "allowed",
    "requester-revoked",
    "execution-reselected",
    "cancelled-before",
    "cancelled-after",
    "read-denied",
    "target-read-denied",
    "execution-unavailable",
    "selection-after",
  ] as const)("publishes personally with worker execution identity: %s", async (scenario) => {
    const repository = await createRepositoryPublicationFixture(checkpoint);
    const originalFetch = globalThis.fetch;
    const person = await createPersonalPublicationFixture();
    const cancellation = new AbortController();
    person.action = await preparePersonalPublicationFixtureAction(person, cancellation.signal);
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    repository.runtime.accountId = personalPublicationAccount.accountId;
    person.config.gateway = {};
    const events: string[] = [];
    const sharedToken = registerPublicationCredentialFixture(person, events);
    const actualIdentity = await vi.importActual<
      typeof import("../agents/github-tool-identity.js")
    >("../agents/github-tool-identity.js");
    mocks.prepareIdentity.mockImplementation(actualIdentity.prepareGitHubPublicationIdentity);
    mocks.matchesIdentity.mockImplementation(
      actualIdentity.matchesPreparedGitHubPublicationIdentity,
    );
    const sharedProfile = "ghp_77777777777777777777777777777777";
    person.config.tools = { github: { profileId: sharedProfile } };
    await actualIdentity.writeManagedGitHubProfileFiles(
      actualIdentity.resolveManagedGitHubProfileDir({
        scope: "system",
        agentId: "main",
        profileId: sharedProfile,
      }),
      { login: "shared-reader", token: sharedToken },
    );
    const personalToken = "synthetic-personal-credential-" + person.generation;
    const personalFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      async (url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
        if (
          url === "https://api.github.com/user" &&
          new Headers(options?.headers).get("Authorization") === "Bearer " + sharedToken
        ) {
          return Response.json({ id: 42, login: "shared-reader" });
        }
        return (url instanceof Request ? url.url : url.toString()).startsWith("http://127.0.0.1:")
          ? originalFetch(url, options)
          : personalFetch(url, options);
      },
    );
    let negativeExercised = false;
    let personalAtWorker = false;
    let sharedAtWorker = false;
    let personalApiCalls = 0;
    const forms = [
      personalToken,
      Buffer.from("x-access-token:" + personalToken).toString("base64"),
      encodeURIComponent(personalToken),
    ];
    const native = await createNativePublicationTransport(
      {
        repository,
        database: openOpenClawStateDatabase(),
        session: { sessionId: SESSION_ID, sessionKey: SESSION_KEY },
        placements: person.placements,
        config: person.config,
        guest: person.action,
      },
      events,
      {
        worker: (value) => {
          if (scenario === "selection-after" && value.includes('"fetch"')) {
            negativeExercised = true;
            expect(integrationSignal?.aborted).toBe(false);
            setRuntimeConfigSnapshot({
              ...person.config,
              tools: { github: { profileId: "ghp_88888888888888888888888888888888" } },
            });
            expect(integrationSignal?.aborted).toBe(true);
          }
          if (scenario === "cancelled-after" && value.includes('"fetch"')) {
            negativeExercised = true;
            cancellation.abort(new Error("Publication cancelled after worker dispatch"));
          }
          personalAtWorker ||= forms.some((secret) => value.includes(secret));
          sharedAtWorker ||=
            value.includes(sharedToken) ||
            value.includes(Buffer.from("x-access-token:" + sharedToken).toString("base64"));
        },
        publisher: (env, argv) => {
          if (env?.GH_TOKEN === sharedToken) {
            expect(argv).toContain("repos/owner/repository");
            expect(argv).not.toContain("POST");
            return;
          }
          expect(env?.GH_TOKEN === personalToken).toBe(true);
          personalApiCalls++;
        },
      },
    );
    const integrate = mocks.prepareRepositoryIntegration.getMockImplementation()!;
    let integrationSignal: AbortSignal | undefined;
    mocks.prepareRepositoryIntegration.mockImplementation(async (identity, input) => {
      integrationSignal = input.signal;
      negativeExercised ||= [
        "requester-revoked",
        "execution-reselected",
        "cancelled-before",
      ].includes(scenario);
      if (scenario === "requester-revoked") {
        person.runtime.live = false;
      }
      if (scenario === "execution-reselected") {
        person.config.tools!.github = { profileId: "ghp_88888888888888888888888888888888" };
      }
      if (scenario === "cancelled-before") {
        cancellation.abort(new Error("Publication cancelled before transfer"));
      }
      return integrate(identity, input);
    });
    if (scenario === "read-denied" || scenario === "target-read-denied") {
      const provider = mocks.runCommand.getMockImplementation()!;
      mocks.runCommand.mockImplementation((argv, options) => {
        const deniedRepository =
          scenario === "read-denied" ? "owner/repository" : "upstream/repository";
        if (options?.env?.GH_TOKEN === sharedToken && argv.includes("repos/" + deniedRepository)) {
          negativeExercised = true;
          return {
            ...commandResult("", 1),
            stderr: Buffer.from("synthetic access denied (HTTP 404)"),
          };
        }
        if (scenario === "target-read-denied" && argv.includes("repos/owner/repository")) {
          return commandResult(
            JSON.stringify({
              node_id: "repository-node",
              fork: true,
              default_branch: "main",
              parent: { name: "repository", owner: { login: "upstream" }, default_branch: "main" },
            }),
          );
        }
        return provider(
          argv.map((arg: string) =>
            arg.replace("repos/upstream/repository", "repos/owner/repository"),
          ),
          options,
        );
      });
    }
    if (scenario === "execution-unavailable") {
      await actualIdentity.removeManagedGitHubProfile(
        actualIdentity.resolveManagedGitHubProfileDir({
          scope: "system",
          agentId: "main",
          profileId: sharedProfile,
        }),
      );
      negativeExercised = true;
    }
    native.recoverProvider();
    const result = await person.coordinator
      .requestPersonalForSessionV2(
        personalPublicationRequest(person, "personal-custody"),
        person.action,
      )
      .catch(() => ({ status: "rejected" as const }));
    if (scenario !== "allowed") {
      expect(negativeExercised).toBe(true);
      if (scenario === "execution-unavailable") {
        expect(result).toMatchObject({
          status: "failed",
          code: "identity_unavailable",
          nextAction: expect.stringContaining("normal worker GitHub execution account"),
        });
      }
      if (scenario === "read-denied" || scenario === "target-read-denied") {
        expect(result).toMatchObject({
          status: "failed",
          code: "identity_unavailable",
          nextAction: expect.stringContaining("source or target repository"),
        });
      }
      if (["execution-reselected", "selection-after"].includes(scenario)) {
        expect(result).toMatchObject({
          status: "failed",
          code: "identity_changed",
          nextAction: expect.stringContaining("worker execution GitHub account"),
        });
      }
      expect(result.status).not.toBe("published");
      expect(native.observed.nativeExecutions).toBe(
        ["cancelled-after", "selection-after"].includes(scenario) ? 1 : 0,
      );
      expect(native.observed.physicalCas).toBe(0);
      expect(repository.runtime.effects).toEqual([]);
      expect(personalAtWorker).toBe(false);
      if (
        scenario !== "read-denied" &&
        scenario !== "target-read-denied" &&
        scenario !== "execution-unavailable"
      ) {
        expect(integrationSignal?.aborted).toBe(true);
      }
      if (scenario === "execution-reselected") {
        person.config.tools!.github = { profileId: sharedProfile };
        const replay = await person.coordinator.requestPersonalForSessionV2(
          personalPublicationRequest(person, "personal-custody"),
          person.action,
        );
        // Terminal personal receipts are immutable: repairing the worker does not
        // reopen the old action or silently create a new request.
        expect(replay).toEqual(result);
        expect(native.observed.physicalCas).toBe(0);
      }
      return;
    }
    expect(integrationSignal?.aborted).toBe(true);
    expect(result.status).toBe("published");
    expect(native.observed.physicalCas).toBe(1);
    expect(repository.runtime.effects).toEqual(["push", "pull_request"]);
    expect(repository.runtime.pr?.userId).toBe(personalPublicationAccount.accountId);
    expect(native.readRef()).toBe(repository.runtime.head);
    expect(repository.git(["show", native.ref + ":counter.txt"])).toBe("accepted first");
    expect(personalApiCalls).toBeGreaterThan(0);
    expect(personalAtWorker).toBe(false);
    expect(sharedAtWorker).toBe(true);
  });
});

describe("publication worker credential lifetime", () => {
  installGitHubPublicationTestHarness();
  it.each([
    "expiry",
    "profile-rotation",
    "release",
    "acquisition-revoked",
    "acquisition-rotation",
    "acquisition-rate-limited",
    "refresh-rotation",
    "runtime-selection",
  ] as const)("closes the fixed operation and joins local cleanup: %s", async (scenario) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let authority = true;
    const assertCurrent = vi.fn(() => {
      if (!authority) {
        throw new Error("Publication owner revoked");
      }
    });
    const identity = {
      source: "system-configured" as const,
      profileId: "ghp_77777777777777777777777777777777",
      account: { accountId: 42, login: "shared-reader" },
      env: { GH_TOKEN: "synthetic-operation-only", GH_CONFIG_DIR: "/synthetic-profile" },
      accessExpiresAtMs: Date.now() + 1_000,
    };
    mocks.refreshIdentity.mockImplementation(async () => {
      if (scenario === "refresh-rotation") {
        notifyManagedGitHubProfileChanged({
          profileDir: identity.env.GH_CONFIG_DIR,
          kind: "updated",
        });
      }
    });
    mocks.prepareIdentity.mockImplementation(async () => {
      if (scenario === "acquisition-rate-limited") {
        throw new GitHubIdentityError("rate_limited");
      }
      if (scenario === "acquisition-rotation") {
        notifyManagedGitHubProfileChanged({
          profileDir: identity.env.GH_CONFIG_DIR,
          kind: "updated",
        });
      }
      if (scenario === "acquisition-revoked") {
        authority = false;
      }
      return identity;
    });
    let owned: Awaited<ReturnType<typeof prepareGitHubPublicationWorkerIdentity>> | undefined;
    const timersBefore = vi.getTimerCount();
    const abort = vi.spyOn(AbortController.prototype, "abort");
    try {
      const preparing = prepareGitHubPublicationWorkerIdentity({
        agentId: "main",
        assertCurrent,
      });
      if (scenario === "acquisition-rate-limited") {
        await expect(preparing).rejects.toMatchObject({
          failure: { code: "unavailable", nextAction: expect.stringContaining("rate limit") },
        });
      } else if (scenario === "acquisition-revoked" || scenario === "acquisition-rotation") {
        if (scenario === "acquisition-revoked") {
          await expect(preparing).rejects.toThrow("Publication owner revoked");
        } else {
          await expect(preparing).rejects.toMatchObject({
            failure: {
              code: "identity_changed",
              nextAction: expect.stringContaining("explicitly request publication again"),
            },
          });
        }
      } else {
        owned = await preparing;
        owned.assertCurrent();
        if (scenario === "runtime-selection") {
          sessionChanges.emit({ all: true, scope: "config" });
          expect(owned.signal.aborted).toBe(false);
          mocks.matchesIdentity.mockReturnValue(false);
          sessionChanges.emit({ all: true, scope: "config" });
        } else if (scenario === "expiry") {
          await vi.advanceTimersByTimeAsync(1_000);
        } else if (scenario === "profile-rotation") {
          notifyManagedGitHubProfileChanged({
            profileDir: identity.env.GH_CONFIG_DIR,
            kind: "updated",
          });
        } else {
          owned.release();
        }
        expect(owned.signal.aborted).toBe(true);
        expect(() => owned!.assertCurrent()).toThrow();
      }
    } finally {
      owned?.release();
      const checks = abort.mock.calls.length;
      notifyManagedGitHubProfileChanged({
        profileDir: identity.env.GH_CONFIG_DIR,
        kind: "removed",
      });
      expect(abort).toHaveBeenCalledTimes(checks);
      abort.mockRestore();
      expect(vi.getTimerCount()).toBe(timersBefore);
      vi.useRealTimers();
    }
  });
  it.each([false, true])(
    "uses committed selection during secrets activation (changed: %s)",
    async (changed) => {
      const state = await vi.importActual<typeof import("../secrets/runtime-state.js")>(
        "../secrets/runtime-state.js",
      );
      const revisions = await import("../agents/auth-profiles/runtime-snapshots.js");
      const { createEmptyRuntimeWebToolsMetadata } =
        await import("../secrets/runtime-fast-path.js");
      const actualIdentity = await vi.importActual<
        typeof import("../agents/github-tool-identity.js")
      >("../agents/github-tool-identity.js");
      mocks.getConfigSnapshot.mockImplementation(state.getActiveSecretsRuntimeConfigSnapshot);
      mocks.matchesIdentity.mockImplementation(
        actualIdentity.matchesPreparedGitHubPublicationIdentity,
      );
      const original = "ghp_11111111111111111111111111111111";
      const replacement = "ghp_99999999999999999999999999999999";
      const activate = (profileId: string, port: number) => {
        const config = { tools: { github: { profileId } }, gateway: { port } };
        state.activateSecretsRuntimeSnapshotState({
          snapshot: {
            sourceConfig: config,
            config,
            authStores: [],
            authStoreCredentialsRevision: revisions.getRuntimeAuthProfileStoreCredentialsRevision(),
            authStoreSnapshotsRevision: revisions.getRuntimeAuthProfileStoreSnapshotsRevision(),
            warnings: [],
            webTools: createEmptyRuntimeWebToolsMetadata(),
          },
          refreshContext: null,
          refreshHandler: null,
        });
      };
      activate(original, 19001);
      const worker = await prepareGitHubPublicationWorkerIdentity({
        agentId: "main",
        assertCurrent: () => {},
      });
      let profileAtNotification: string | undefined;
      const stop = sessionChanges.subscribe((change) => {
        if (change.scope === "config") {
          profileAtNotification =
            state.getActiveSecretsRuntimeConfigSnapshot()?.config.tools?.github?.profileId;
        }
      });
      try {
        activate(changed ? replacement : original, 19002);
        expect(profileAtNotification).toBe(original);
        expect(worker.signal.aborted).toBe(changed);
        if (changed) {
          expect(() => worker.assertCurrent()).toThrow("worker GitHub identity changed");
        } else {
          worker.assertCurrent();
        }
      } finally {
        stop();
        worker.release();
        state.clearSecretsRuntimeSnapshotState();
      }
    },
  );
});
