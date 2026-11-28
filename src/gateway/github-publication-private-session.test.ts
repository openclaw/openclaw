// Register external transport fixtures before loading publication owners.
// oxfmt-ignore
import { root, githubPublicationTestMocks, installGitHubPublicationTestHarness } from "./github-publication.test-support.js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { listSessionChildEntriesReadOnly } from "../config/sessions/session-entry-children-read.js";
import { withSessionStoreReaderInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import {
  createLocalPublicationFixture,
  useRealSessionReads,
} from "./github-publication-requester.test-support.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { sessionClassificationForRow } from "./session-classification.js";
import { createGatewaySession } from "./session-create-service.js";

const mocks = githubPublicationTestMocks();
describe("private local checkout publication", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    realWorktree: true,
  });
  it("keeps private publication session rows in memory and reuses its accepted checkout", async () => {
    const f = await createLocalPublicationFixture();
    await useRealSessionReads();
    const source = f.local!;
    setRuntimeConfigSnapshot({
      ...f.config,
      agents: { entries: { main: { workspace: root } } },
    });
    const actual = await vi.importActual<typeof import("../agents/worktrees/service.js")>(
      "../agents/worktrees/service.js",
    );
    const registry = await vi.importActual<typeof import("../agents/worktrees/registry-read.js")>(
      "../agents/worktrees/registry-read.js",
    );
    mocks.resolveRepository.mockImplementation(
      actual.managedWorktrees.resolveRepositoryIdentity.bind(actual.managedWorktrees),
    );
    mocks.readWorktree.mockImplementation(registry.readLiveRegistryWorktreeByOwner);
    await source.git("remote", "add", "origin", "https://github.com/openclaw/openclaw.git");
    await source.git("add", "artifact.txt");
    await source.git("commit", "-m", "Implement private task");
    const location = {
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
    };
    onTestFinished(() => memorySessionActorOwners.closeDatabase(location));
    const created = await createGatewaySession({
      cfg: getRuntimeConfig(),
      agentId: "main",
      incognito: true,
      requestingOperatorScopes: ["operator.admin"],
      operatorRoleActor: { kind: "system" },
      creation: { via: "operator", actor: { type: "system" } },
      commandSource: "test",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error(created.error.message);
    }
    const scope = { agentId: "main", sessionKey: created.key };
    const client = createSyntheticPluginRuntimeClient({
      operatorRoleActor: { kind: "system" },
      scopes: ["operator.admin"],
    });
    const context = {
      ...createDirectChatContext({ getRuntimeConfig }),
      workerSessionPlacementService: f.placements,
      githubPublicationService: f.coordinator,
    };
    const invoke = async () => {
      const respond = vi.fn();
      await withGatewayToolCallerIdentity(
        { ...scope, workspacePrAdoptionSessionId: created.entry.sessionId },
        () =>
          handleGatewayRequest({
            req: {
              type: "req",
              id: "private-publication",
              method: "sessions.github.publish",
              params: {
                ...scope,
                workspacePath: source.cwd,
                idempotencyKey: "private-publication",
              },
            },
            context,
            client,
            isWebchatConnect: () => false,
            respond,
          }),
      );
      return respond.mock.calls[0];
    };
    const result = await invoke();
    expect(result).toMatchObject([true, { status: "published" }]);
    expect(await invoke()).toEqual(result);
    const children = await listSessionChildEntriesReadOnly(scope);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      sessionKey: expect.stringMatching(/^agent:main:dashboard:incognito-/u),
      entry: {
        incognito: true,
        createdSurface: "github-publication",
        parentSessionKey: created.key,
        worktree: { canonicalWorkspaceDir: source.cwd },
      },
    });
    expect(
      sessionClassificationForRow(
        getRuntimeConfig(),
        children[0]!.sessionKey,
        "main",
        children[0]!.entry,
      ),
    ).toMatchObject({
      classification: "github-publication",
      isBackground: true,
    });
    const durable = await withSessionStoreReaderInWorker(
      { agentId: "main", storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }) },
      ({ reader, database, continuation }) =>
        reader.readExactEntries({
          sessionKeys: [created.key, children[0]!.sessionKey],
          env: database.env,
          continuation,
        }),
      { backing: true, dataOnly: true },
    );
    expect(durable.entries).toEqual([]);
    expect(loadSessionEntryReadOnly(scope)?.worktree).toBeUndefined();
    expect(source.effects).toEqual(["push", "pull_request"]);
  });
});
