import { afterEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  authority,
  memoryOwnerFixture,
} from "../config/sessions/session-actor-memory-family.test-support.js";
import { runWithSessionActorStorage } from "../config/sessions/session-actor-storage-binding.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveApprovalRequestChannelAccountId } from "../infra/approval-request-account-binding.js";
import * as checkoutDiff from "../sessions/session-diff.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { withControlUiSessionPrSource } from "./control-ui-session-pr-source.js";
import { prepareGitHubPublicationSession } from "./github-publication-availability.js";
import { withSessionFileRoot } from "./server-methods/session-files-root.js";
import { loadSessionDiff } from "./server-methods/sessions-diff.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory effect read opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory effect read allocated a worker");
  }),
}));

const sessionKey = "agent:main:dashboard:incognito-effects";
afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});
const acquireMemory = memoryOwnerFixture({
  agentId: "main",
  path: resolveIncognitoOpenClawAgentSqlitePath({
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: "/synthetic" },
  }),
});

async function fixture() {
  const { owner, actor, store } = await acquireMemory(sessionKey);
  const mutate = async (operation: Parameters<typeof store.mutate>[0]) => {
    expect(await store.mutate(operation, authority)).toMatchObject({ kind: "committed" });
  };
  await mutate({
    type: "session.entry.create",
    input: {
      entry: {
        sessionId: "private-effects",
        updatedAt: 1,
        lifecycleRevision: "original",
        spawnedCwd: "/synthetic/workspace",
      },
    },
  });
  const binding = { actor, authority, agentId: owner.agentId, path: owner.path };
  const patch = (value: Partial<SessionEntry>) =>
    mutate({ type: "session.entry.patch", input: { operation: { kind: "fields", patch: value } } });
  return { owner, actor, binding, patch };
}

function delivery(accountId: string): SessionEntry["delivery"] {
  return {
    kind: "external",
    context: { channel: "slack", accountId, to: "channel:C123" },
    origin: { provider: "slack", accountId, to: "channel:C123" },
    route: { channel: "slack", accountId, target: { to: "channel:C123", chatType: "channel" } },
  };
}

it("routes approvals from the memory actor's latest committed channel account", async () => {
  const { binding, patch } = await fixture();
  const params = {
    cfg: {},
    channel: "slack",
    request: {
      id: "approval",
      request: { command: "echo synthetic", sessionKey },
      createdAtMs: 1,
      expiresAtMs: 2,
    },
  };
  await runWithSessionActorStorage(binding, async () => {
    await patch({ delivery: delivery("first") });
    expect(resolveApprovalRequestChannelAccountId(params)).toBe("first");
    await patch({ delivery: delivery("second") });
    expect(resolveApprovalRequestChannelAccountId(params)).toBe("second");
  });
});

it("keeps file planning detached and refuses disclosure after its workspace changes", async () => {
  const { binding, patch } = await fixture();
  await expect(
    runWithSessionActorStorage(binding, () =>
      withSessionFileRoot({ sessionKey }, {}, async (loaded, assertCurrent) => {
        expect(loaded.root).toBe("/synthetic/workspace");
        await patch({ spawnedCwd: "/synthetic/replacement" });
        expect(loaded.root).toBe("/synthetic/workspace");
        using publication = await prepareGitHubPublicationSession(sessionKey);
        expect(publication.readCurrent().entry?.spawnedCwd).toBe("/synthetic/replacement");
        assertCurrent();
      }),
    ),
  ).rejects.toThrow("Session workspace changed during file access");
});

it("revokes a retained PR publication source when its session actor closes", async () => {
  const { owner, binding } = await fixture();
  const assertCurrent = await runWithSessionActorStorage(binding, () =>
    withControlUiSessionPrSource(binding, async (assertSourceCurrent) => assertSourceCurrent),
  );
  expect(() => assertCurrent()).not.toThrow();
  owner.closeSession(sessionKey);
  expect(() => assertCurrent()).toThrow();
});

it("revokes a host diff when runtime configuration removes its read-only sandbox mount", async () => {
  const { binding } = await fixture();
  const cfg: OpenClawConfig = {
    agents: { defaults: { sandbox: { mode: "all", workspaceAccess: "ro" } } },
  };
  setRuntimeConfigSnapshot(cfg);
  vi.spyOn(checkoutDiff, "loadCheckoutDiff").mockImplementationOnce(async () => {
    setRuntimeConfigSnapshot({
      agents: { defaults: { sandbox: { mode: "all", workspaceAccess: "none" } } },
    });
    return { sessionKey, files: [], additions: 0, deletions: 0 };
  });
  await expect(
    runWithSessionActorStorage(binding, () => loadSessionDiff({ sessionKey })),
  ).rejects.toThrow("Session workspace changed during file access");
});
