import { afterEach, expect, it, vi } from "vitest";
import type {
  GitHubAppSelection,
  GitHubCredentialReader,
} from "../../agents/github-credential-reader.js";
import type { RepositoryIntegration } from "../../plugins/repository-integration.types.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
const policy = vi.hoisted(() => ({ integration: undefined as RepositoryIntegration | undefined }));
vi.mock("../../plugins/repository-integration-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/repository-integration-runtime.js")>()),
  getRepositoryIntegration: () => policy.integration,
}));
import { handleGatewayRequest } from "../server-methods.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { ACTIVE_PLACEMENT } from "../worker-environments/placement-dispatch-coordinator.test-support.js";
import { createDispatchEnvironmentFixtures } from "../worker-environments/placement-dispatch-test-fixtures.js";
import { createWorkerPlacementRedispatch } from "../worker-environments/worker-placement-redispatch.js";
import {
  setClientProfile,
  useBrowserFollowupFixture,
} from "./chat-send-pending-inputs.test-support.js";
import type { RespondFn } from "./types.js";

installGatewayTestHooks();
const createFixture = useBrowserFollowupFixture();
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  policy.integration = undefined;
});

it("fresh authenticated same-SID chat.send retains exact repository admission through reclaimed checkout", async () => {
  const fixture = await createFixture({ active: false });
  const profile = ensureProfileForEmail("github:microsoft.ghe.com:101");
  setClientProfile(fixture.client, profile);
  fixture.client.authenticatedGitHubAccountId = 101;
  fixture.client.internal = { authenticatedControlUi: true, authenticatedOperator: true };
  const selection: GitHubAppSelection = {
    kind: "app-installation",
    profileId: "ghp_6128c113c0df8c1a366dfe690c062d8e",
    app: {
      appId: 10,
      installationId: 20,
      accountId: 30,
      repositories: [{ id: 40, fullName: "example/repository" }],
      permissions: { contents: "write" },
      privateKey: "synthetic",
      keyVersion: "v1",
    },
  };
  const digests: string[] = [];
  policy.integration = {
    version: 1,
    preparedCapacity: "image",
    resolveConnectionIdentity: () => undefined,
    async withIdentity(context, run) {
      context.assertCurrent();
      expect(context.actor).toMatchObject({ actorId: 101, profileId: profile.id });
      expect(context.operation).toMatchObject({
        purpose: "session-dispatch-project",
        binding: {
          kind: "session-dispatch",
          agentId: "main",
          sessionKey: fixture.scope.sessionKey,
          sessionId: fixture.scope.sessionId,
        },
      });
      digests.push(context.operation.binding.requestDigest!);
      return await run({
        env: context.env,
        assertCurrent: context.assertCurrent,
        readNativeCredential: async (_env, admission) => {
          context.assertCurrent();
          expect(admission).toEqual({
            kind: "repository-admission",
            host: "github.com",
            selection: {
              kind: "app-installation",
              profileId: selection.profileId,
              app: {
                appId: 10,
                installationId: 20,
                accountId: 30,
                repositories: [{ id: 40, fullName: "example/repository" }],
                permissions: { contents: "write" },
              },
            },
          });
          return undefined;
        },
      });
    },
  };
  const placement = { ...ACTIVE_PLACEMENT, ...fixture.scope, state: "reclaimed" as const };
  const environment = {
    ...createDispatchEnvironmentFixtures().ready,
    environmentId: placement.environmentId!,
    providerId: "crabbox",
    state: "destroyed" as const,
  };
  let retainedReader: GitHubCredentialReader | undefined;
  const redispatch = createWorkerPlacementRedispatch({
    placements: {
      readProjection: async () => ({
        placements: new Map([[placement.sessionId, placement]]),
        environments: new Map([[environment.environmentId, environment]]),
        moves: new Map(),
        pendingResults: new Map(),
        workspaceJournalOwnerSessionIds: new Set<string>(),
        workspaceResultReconcilingSessionIds: new Set<string>(),
        workspaceRecoveryPendingSessionIds: new Set<string>(),
      }),
    },
    dispatch: async (request) => {
      if (!request.readNativeCredential) {
        throw new Error("Repository worker startup requires current GitHub dispatch admission");
      }
      retainedReader = request.readNativeCredential;
      await request.readNativeCredential(process.env, {
        kind: "repository-admission",
        host: "github.com",
        selection,
      });
      return { ...ACTIVE_PLACEMENT, ...fixture.scope };
    },
  });
  dispatchInboundMessageMock.mockImplementation(async () => {
    await redispatch(placement, { assertCurrent: () => {} });
    return {};
  });
  try {
    for (const runId of ["fresh-turn-1", "fresh-turn-2"]) {
      fixture.params.idempotencyKey = runId;
      const respond = vi.fn<RespondFn>();
      await handleGatewayRequest({
        req: { type: "req", id: runId, method: "chat.send", params: fixture.params },
        client: fixture.client,
        context: fixture.context,
        respond,
        isWebchatConnect: () => true,
      });
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      await fixture.finishDispatch();
    }
    expect(digests).toHaveLength(2);
    expect(new Set(digests).size).toBe(2);
    await expect(
      retainedReader!(process.env, { kind: "repository-admission", host: "github.com", selection }),
    ).rejects.toThrow("released");
    fixture.client.invalidated = true;
    await expect(redispatch(placement, { assertCurrent: () => {} })).rejects.toThrow(
      "current GitHub dispatch admission",
    );
    expect(digests).toHaveLength(2);
  } finally {
    await fixture.cleanup();
  }
});
