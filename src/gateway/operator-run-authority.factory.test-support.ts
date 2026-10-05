import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, onTestFinished, vi } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  readAdmittedRunOperatorAuthority,
  resolveAdmittedRunActiveAssertion,
} from "../agents/admitted-run-context.js";
import { clearGitHubCredentialVerificationCache } from "../agents/github-oauth-client.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as command from "../process/exec.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { setCanonicalUserProfileRole } from "../state/user-profile-writes.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { factoryGitHubRequestDigest } from "./factory-github-proof.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { factoryGitHubProofHandlers } from "./server-methods/factory-github-proof.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import {
  createContext,
  createOperatorClient,
} from "./server-plugin-in-process-dispatch.test-support.js";
import {
  createDispatchEnvironmentFixtures,
  REQUEST,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "./worker-environments/placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { createWorkerProviderIntent } from "./worker-environments/provider-intent.js";
import { createProvider } from "./worker-environments/service.test-support.js";
import { createWorkerEnvironmentStore } from "./worker-environments/store.js";
import { createWorkerPlacementRedispatch } from "./worker-environments/worker-placement-redispatch.js";

export type ReclaimedFactoryCredentialVariant =
  | "current"
  | "actor changed"
  | "missing"
  | "unattested"
  | "synthetic"
  | "restored without producer"
  | "narrowed"
  | "released"
  | "cancelled"
  | "wrong SID"
  | "wrong key"
  | "wrong agent"
  | "actor changed during lookup"
  | "profile changed during lookup"
  | "disconnected during lookup"
  | "cancelled during lookup"
  | "released during lookup"
  | "grant revoked during lookup"
  | "role revoked during lookup"
  | "placement replaced during lookup"
  | "workspace changed during lookup";

export async function exerciseReclaimedFactoryCredential(
  variant: ReclaimedFactoryCredentialVariant,
) {
  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    clearGitHubCredentialVerificationCache();
    clearRuntimeConfigSnapshot();
  });
  const { ready } = createDispatchEnvironmentFixtures();
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    vi.stubEnv("GH_CONFIG_DIR", state.statePath("gh"));
    for (const key of [
      "GH_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
    ]) {
      vi.stubEnv(key, undefined);
    }
    const actorId = 17235;
    const profile = ensureProfileForEmail(`github:microsoft.ghe.com:${actorId}`);
    const client = createOperatorClient({ profileId: profile.id, scopes: ["operator.write"] });
    client.authenticatedFactoryGitHubAccountId = actorId;
    client.internal = { authenticatedOperator: true };
    if (variant === "unattested") {
      delete client.internal.authenticatedOperator;
    } else if (variant === "synthetic") {
      client.internal.syntheticClient = true;
    }
    const connection = new AbortController();
    client.connectionSignal = connection.signal;
    const grant = new AbortController();
    const cancellation = new AbortController();
    const config: OpenClawConfig = {
      gateway: {
        github: { host: "microsoft.ghe.com", apiBaseUrl: "https://api.microsoft.ghe.com" },
      },
      cloudWorkers: {
        profiles: { development: { provider: "fake", settings: { region: "test" } } },
      },
    };
    setRuntimeConfigSnapshot(config);
    const context = createContext();
    context.getRuntimeConfig = () => config;
    const captured = expectDefined(
      await captureGatewayOperatorRunAuthority({
        client,
        context,
        sourceAuthority: {
          signal: grant.signal,
          assertCurrent: () => grant.signal.throwIfAborted(),
        },
      }),
      "real Factory source",
    );
    const admission = prepareAgentRunAdmission({
      cfg: config,
      facts: {
        runId: "reclaimed-fixture",
        agentId: REQUEST.agentId,
        ingress: { kind: "system", boundary: "test", state: "present" },
      },
      operationalRunInstance: createOperationalRunInstanceRef("reclaimed-fixture"),
      operatorAuthority: captured.authority,
    });
    const admitted = await admission.admit("embedded");
    captured.release();
    const assertCurrent = expectDefined(
      resolveAdmittedRunActiveAssertion(admitted),
      "current admitted run",
    );
    const originalAuthority = expectDefined(
      readAdmittedRunOperatorAuthority(admitted),
      "retained original source",
    );
    const operatorAuthority =
      variant === "missing"
        ? undefined
        : variant === "restored without producer"
          ? createAdmittedRunOperatorAuthority({
              ...originalAuthority,
              createFactoryGitHubDispatchCredentialReader: undefined,
            })
          : variant === "narrowed"
            ? createAdmittedRunOperatorAuthority({
                ...originalAuthority,
                scopes: ["operator.read"],
              })
            : originalAuthority;
    const database = openOpenClawStateDatabase();
    const repositoryStore = createSessionRepositoryWorkspaceStore({ path: database.path });
    const repository = await repositoryStore.create({
      agentId: REQUEST.agentId,
      sessionKey: REQUEST.sessionKey,
      url: "https://microsoft.ghe.com/acme/project.git",
      requestedRef: "main",
      runSetupScript: false,
      assertCurrent,
    });
    const resolveWorkspace = async (identity: {
      agentId: string;
      sessionKey: string;
      sessionId: string;
    }) => {
      assertCurrent();
      return {
        kind: "repository" as const,
        repository: expectDefined(await repositoryStore.find(identity), "canonical repository"),
      };
    };
    const placements = createWorkerSessionPlacementStore({ database });
    const harness = createHarness(database, placements, {
      resolveWorkspace,
      requiresNodeEnrollment: true,
      failAt: "create",
    });
    const active = await harness.placements.seedActive(ready.ownerEpoch);
    const draining = await placements.startDrain({
      sessionId: active.sessionId,
      environmentId: ready.environmentId,
      ownerEpoch: ready.ownerEpoch,
      expectedGeneration: active.generation,
    });
    const reconciling = await placements.startReconcile({
      sessionId: active.sessionId,
      environmentId: ready.environmentId,
      ownerEpoch: ready.ownerEpoch,
      expectedGeneration: draining.generation,
    });
    const placement = await placements.transition({
      sessionId: active.sessionId,
      from: "reconciling",
      to: "reclaimed",
      expectedGeneration: reconciling.generation,
    });
    if (placement.state !== "reclaimed") {
      throw new Error("Fixture did not admit the reclaimed source");
    }
    const provider = createProvider({
      requiresNodeEnrollment: true,
      supportsProjectPreparation: () => true,
    });
    const store = await createWorkerEnvironmentStore({ database });
    const intent = createWorkerProviderIntent({
      store,
      getConfig: () => config,
      projectNamespace: "reclaimed-fixture",
      providerFor: () => provider,
      isStopping: () => false,
      withLock: async (_id, task) => task(),
      resumeProvision: async () => {
        throw new Error("unexpected provider operation");
      },
    });
    vi.mocked(harness.environments.prepareProjectIntent).mockImplementation(intent.prepareIntent);
    vi.mocked(harness.environments.assertPreparedIntentCurrent).mockImplementation(
      intent.assertPreparedIntentCurrent,
    );
    vi.mocked(harness.environments.revalidatePreparedIntentRepository).mockImplementation(
      intent.revalidatePreparedIntentRepository,
    );
    const proofs = new Set<string>();
    const native = vi
      .spyOn(command, "runCommandBuffered")
      .mockImplementation(async (argv, options) => {
        if (argv[2] === "status") {
          return {
            stdout: Buffer.from('{"hosts":{}}'),
            stderr: Buffer.alloc(0),
            code: 0,
            signal: null,
            killed: false,
            termination: "exit",
          };
        }
        expect(argv.slice(1)).toEqual(["auth", "token", "--hostname", "microsoft.ghe.com"]);
        const proof = options?.env?.OPENCLAW_FACTORY_GITHUB_PROOF;
        if (!proof) {
          return {
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            code: 1,
            signal: null,
            killed: false,
            termination: "exit",
          };
        }
        expect(proofs.has(proof)).toBe(false);
        proofs.add(proof);
        const respond = vi.fn();
        const redeem = expectDefined(
          factoryGitHubProofHandlers["factory.githubPublication.redeem"],
          "registered private redemption",
        );
        const request: GatewayRequestHandlerOptions = {
          req: {
            type: "req" as const,
            id: "reclaimed-lookup",
            method: "factory.githubPublication.redeem",
            params: { proof },
          },
          client: {
            ...createOperatorClient({ profileId: profile.id, scopes: ["operator.admin"] }),
            internal: {
              isLocalClient: true,
              authenticatedOperator: true,
              operatorRoleActor: { kind: "system" },
            },
          },
          context: { ...context, isConnectionActive: () => true },
          params: { proof },
          respond,
          hasCurrentClientAuthority: () => true,
          isWebchatConnect: () => false,
        };
        await redeem(request);
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            actorId,
            profileId: profile.id,
            purpose: "session-dispatch-project",
            binding: {
              kind: "session-dispatch",
              agentId: REQUEST.agentId,
              sessionKey: REQUEST.sessionKey,
              sessionId: REQUEST.sessionId,
              requestDigest: factoryGitHubRequestDigest(repository.url),
            },
          }),
        );
        const replay = vi.fn();
        await redeem({ ...request, respond: replay });
        expect(replay).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "FORBIDDEN" }),
        );
        await Promise.resolve();
        if (variant === "actor changed during lookup") {
          client.authenticatedFactoryGitHubAccountId = actorId + 1;
        } else if (variant === "profile changed during lookup") {
          client.authenticatedUserProfile = {
            ...expectDefined(client.authenticatedUserProfile, "profile"),
            profileId: "replaced-profile",
          };
        } else if (variant === "disconnected during lookup") {
          connection.abort(new Error("connection closed"));
        } else if (variant === "cancelled during lookup") {
          cancellation.abort(new Error("turn cancelled"));
        } else if (variant === "released during lookup") {
          admission.close();
        } else if (variant === "grant revoked during lookup") {
          grant.abort(new Error("grant ended"));
        } else if (variant === "role revoked during lookup") {
          await setCanonicalUserProfileRole(profile.id, "revoked", {
            onCommitted: invalidateOperatorRolePolicy,
          });
        } else if (variant === "placement replaced during lookup") {
          const current = expectDefined(placements.get(REQUEST.sessionId), "dispatch owner");
          await placements.fail({
            sessionId: current.sessionId,
            expectedGeneration: current.generation,
            recoveryError: "replaced",
          });
          await placements.startDispatch(REQUEST);
        } else if (variant === "workspace changed during lookup") {
          await repositoryStore.bindBase({
            workspaceId: repository.workspaceId,
            expectedRevision: repository.revision,
            baseCommit: "a".repeat(40),
            assertCurrent,
          });
        }
        return {
          stdout: Buffer.from("synthetic-reclaimed-token"),
          stderr: Buffer.alloc(0),
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        };
      });
    const commit = "a".repeat(40);
    const tree = "b".repeat(40);
    const fetchFixture = vi.fn<typeof fetch>(async (input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toContain(
        "synthetic-reclaimed-token",
      );
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      const metadata = {
        node_id: "R_reclaimed_fixture",
        clone_url: repository.url,
        private: true,
        default_branch: "main",
      };
      let body: unknown;
      if (path.endsWith("/user")) {
        body = { id: 731, login: "fixture-system-account", type: "User" };
      } else if (path.endsWith("/graphql")) {
        body = {
          data: {
            node: {
              ...metadata,
              __typename: "Repository",
              object: { __typename: "Commit", sha: commit, tree: { sha: tree } },
            },
          },
        };
      } else if (path.includes("/commits/")) {
        body = { sha: commit, commit: { tree: { sha: tree } } };
      } else if (path.includes("/git/trees/")) {
        body = { sha: tree, truncated: false, tree: [] };
      } else {
        expect(path).toBe("/repos/acme/project");
        body = metadata;
      }
      return Response.json(body);
    });
    vi.stubGlobal("fetch", fetchFixture);
    const dependencies = {
      dispatch: harness.service.dispatch,
      placements,
    };
    const redispatch = createWorkerPlacementRedispatch(dependencies);
    if (variant === "actor changed") {
      client.authenticatedFactoryGitHubAccountId = actorId + 1;
    } else if (variant === "released") {
      admission.close();
    } else if (variant === "cancelled") {
      cancellation.abort(new Error("turn cancelled"));
    }
    const target = {
      ...placement,
      ...(variant === "wrong SID" ? { sessionId: "wrong-sid" } : {}),
      ...(variant === "wrong key" ? { sessionKey: "agent:main:wrong-key" } : {}),
      ...(variant === "wrong agent" ? { agentId: "wrong-agent" } : {}),
    };
    try {
      const result = redispatch(target, {
        assertCurrent,
        operatorAuthority,
        signal: cancellation.signal,
      });
      if (variant === "current") {
        await expect(result).rejects.toThrow("create failed");
        expect(proofs.size).toBeGreaterThan(1);
        expect(harness.environments.createWithRequest).toHaveBeenCalledOnce();
        const reader = expectDefined(
          vi.mocked(harness.environments.prepareProjectIntent).mock.calls[0]?.[1]
            ?.readNativeCredential,
          "admitted credential reader",
        );
        const calls = native.mock.calls.length;
        await expect(reader({})).rejects.toThrow("already settled");
        expect(native).toHaveBeenCalledTimes(calls);
      } else {
        await expect(result).rejects.toThrow();
        expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
        expect(fetchFixture).not.toHaveBeenCalled();
        expect(proofs.size).toBe(variant.includes("during lookup") ? 1 : 0);
        expect(native).toHaveBeenCalledTimes(variant.includes("during lookup") ? 1 : 0);
      }
      expect(native.mock.calls.some(([argv]) => argv[2] === "status")).toBe(false);
    } finally {
      admission.close();
      vi.unstubAllGlobals();
    }
  });
}
