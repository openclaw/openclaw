import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applySessionEntryLifecycleMutation,
  deleteSessionEntryLifecycle,
  patchSessionEntryCore,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { readGitHubPublicationSessionLifecycle } from "../state/github-publication-session-lifecycles.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { readUserGitHubConnection } from "../state/user-github-connections.js";
import { readPersonalGitHubPublication } from "./github-personal-publication-store.js";
import {
  callPersonalPublicationRpc,
  createPersonalPublicationFixture,
  personalPublicationAccount as account,
} from "./github-personal-publication.test-support.js";
import {
  SESSION_KEY,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  persistPublicationTestSession,
} from "./github-publication.test-support.js";
import { preparePersonalGitHubSessionAction } from "./server-methods/github-personal-authorization.js";

const mocks = githubPublicationTestMocks();

vi.mock("../agents/worktrees/git-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/worktrees/git-lock.js")>()),
  lockWorktreeForProcess: vi.fn(async () => undefined),
  unlockWorktree: vi.fn(async () => undefined),
}));
vi.mock("../process/exec.js", () => ({
  runCommandBuffered: (
    ...args: Parameters<typeof import("../process/exec.js").runCommandBuffered>
  ) => mocks.runCommand(...args),
}));

describe("personal publication session lifecycle", () => {
  installGitHubPublicationTestHarness();
  let fixture: Awaited<ReturnType<typeof createPersonalPublicationFixture>>;
  beforeEach(async () => {
    fixture = await createPersonalPublicationFixture();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const request = () => ({
    sessionKey: SESSION_KEY,
    idempotencyKey: "personal-publish",
    selection: { source: "personal" as const, generation: fixture.generation, account },
  });
  const rpc = (method: string, params?: Record<string, unknown>) =>
    callPersonalPublicationRpc(
      { client: fixture.client, context: fixture.context, coordinator: fixture.coordinator },
      method,
      params,
    );

  it("preserves repository receipts when a session is recreated before receipt deletion admission", async () => {
    const { owner, client, context, coordinator } = fixture;
    const session = await persistPublicationTestSession();
    const action = preparePersonalGitHubSessionAction(
      { client, context },
      { sessionKey: SESSION_KEY },
    );
    const published = await coordinator.requestPersonalForSession(request(), action);
    const receipt = readPersonalGitHubPublication(owner, { requestId: published.requestId });
    expect(receipt?.status).toBe("published");
    const binding = { publicationKind: "personal" as const, requestId: published.requestId };
    const lifecycle = readGitHubPublicationSessionLifecycle(binding);
    const repositories = getSessionRepositoryWorkspaceStore();
    const workspace = repositories.create({
      agentId: "main",
      sessionKey: SESSION_KEY,
      url: "https://github.com/example/receipt-guard.git",
      requestedRef: "main",
      assertCurrent: () => {},
    });
    const original = session.read();
    const waiting = createDeferredCore();
    const release = createDeferredCore();
    const runOperation = stateWorker.runOpenClawStateWorkerOperation;
    const holdReceipt = vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
      new Proxy(runOperation, {
        apply(
          target,
          receiver,
          [workerContext, operation, options]: Parameters<typeof runOperation>,
        ) {
          return Reflect.apply(target, receiver, [
            workerContext,
            (scope: Parameters<typeof operation>[0]) =>
              operation({
                execute: new Proxy(scope.execute, {
                  async apply(execute, executeReceiver, args: Parameters<typeof scope.execute>) {
                    if (args[0].type === "githubPublication.deleteSessionReceipts") {
                      waiting.resolve();
                      await release.promise;
                    }
                    return Reflect.apply(execute, executeReceiver, args);
                  },
                }),
              }),
            options,
          ]);
        },
      }),
    );
    const deletion = applySessionEntryLifecycleMutation({
      agentId: "main",
      storePath: session.storePath,
      removals: [{ sessionKey: SESSION_KEY, expectedEntry: original }],
      skipMaintenance: true,
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      await Promise.race([
        waiting.promise,
        deletion.then((outcome) => {
          throw new Error("Session deletion settled before receipt cleanup reached its worker", {
            cause: outcome,
          });
        }),
      ]);
      expect(session.read()).toBeUndefined();
      expect(readPersonalGitHubPublication(owner, { requestId: published.requestId })).toEqual(
        receipt,
      );
      const successor = {
        ...original,
        sessionId: "receipt-guard-successor",
        lifecycleRevision: "receipt-guard-successor-generation",
        updatedAt: Date.now(),
      };
      replaceSessionEntrySync(
        { agentId: "main", storePath: session.storePath, sessionKey: SESSION_KEY },
        successor,
      );
      release.resolve();
      expect(await deletion).toMatchObject({
        ok: false,
        error: expect.objectContaining({
          message: expect.stringContaining("Repository workspace session changed before deletion"),
        }),
      });
      expect(session.read()).toMatchObject(successor);
      expect(repositories.get(workspace.workspaceId)).toEqual(workspace);
      expect(readPersonalGitHubPublication(owner, { requestId: published.requestId })).toEqual(
        receipt,
      );
      expect(readGitHubPublicationSessionLifecycle(binding)).toEqual(lifecycle);
    } finally {
      release.resolve();
      await deletion;
      holdReceipt.mockRestore();
    }
  });

  it("retains logical-session receipts across archive and reset, then removes them through permanent deletion", async () => {
    const { owner, client, context, coordinator, generation, placements } = fixture;
    const session = await persistPublicationTestSession();
    const action = preparePersonalGitHubSessionAction(
      { client, context },
      { sessionKey: SESSION_KEY },
    );
    const result = await coordinator.requestPersonalForSession(request(), action);
    const receipt = readPersonalGitHubPublication(owner, { requestId: result.requestId });
    expect(receipt?.status).toBe("published");
    const binding = { publicationKind: "personal" as const, requestId: result.requestId };
    const originalLifecycle = readGitHubPublicationSessionLifecycle(binding);
    const lifecycle_revision = session.read().lifecycleRevision;
    expect(originalLifecycle).toEqual({ lifecycle_revision, requester_authority_json: null });
    await session.reset(placements);
    expect(readPersonalGitHubPublication(owner, { requestId: result.requestId })).toEqual(receipt);
    expect(
      (
        await rpc("sessions.github.status", {
          requestId: result.requestId,
          sessionKey: SESSION_KEY,
        })
      )[1],
    ).toMatchObject({ result: { status: "published" }, confirmation: null });
    const storePath = session.storePath;
    await patchSessionEntryCore({ agentId: "main", sessionKey: SESSION_KEY, storePath }, () => ({
      archivedAt: Date.now(),
    }));
    const target = { canonicalKey: SESSION_KEY, storeKeys: [SESSION_KEY] };
    expect(readPersonalGitHubPublication(owner, { requestId: result.requestId })).toEqual(receipt);
    expect(readGitHubPublicationSessionLifecycle(binding)).toEqual(originalLifecycle);
    await deleteSessionEntryLifecycle({
      agentId: "main",
      storePath,
      target,
      archiveTranscript: false,
    });
    expect(readPersonalGitHubPublication(owner, { requestId: result.requestId })).toBeUndefined();
    expect(readGitHubPublicationSessionLifecycle(binding)).toBeUndefined();
    expect(readUserGitHubConnection(owner)?.generation).toBe(generation);
  });
});
