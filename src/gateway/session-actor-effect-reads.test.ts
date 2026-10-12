import { afterEach, expect, it, vi } from "vitest";
import type { SessionActorAuthority } from "../config/sessions/session-actor-contract.js";
import { createMemorySessionActorOwner } from "../config/sessions/session-actor-memory.js";
import { runWithSessionActorStorage } from "../config/sessions/session-actor-storage-binding.js";
import {
  captureSessionEntryMetadataRead,
  captureSessionEntrySourceAssertion,
} from "../config/sessions/session-entry-source-authority.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveApprovalRequestChannelAccountId } from "../infra/approval-request-account-binding.js";
import { withControlUiSessionPrSource } from "./control-ui-session-pr-source.js";
import { readGitHubPublicationSession } from "./github-publication-availability.js";
import { withSessionFileRoot } from "./server-methods/sessions-files.js";

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

const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const sessionKey = "agent:main:dashboard:incognito-effects";
const owners: ReturnType<typeof createMemorySessionActorOwner>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.close();
  }
});

async function fixture() {
  const owner = createMemorySessionActorOwner({
    agentId: "main",
    path: "/synthetic/agents/main/sessions/incognito.sqlite",
  });
  owners.push(owner);
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  if (!actor.storage) {
    throw new Error("Memory actor has no storage capability");
  }
  const store = actor.storage;
  expect(
    await store.mutate(
      {
        type: "session.entry.create",
        input: {
          entry: {
            sessionId: "private-effects",
            updatedAt: 1,
            lifecycleRevision: "original",
            spawnedCwd: "/synthetic/workspace",
          },
        },
      },
      authority,
    ),
  ).toMatchObject({ kind: "committed" });
  const binding = { actor, authority, agentId: owner.agentId, path: owner.path };
  const patch = async (value: Partial<SessionEntry>) => {
    expect(
      await store.mutate(
        { type: "session.entry.patch", input: { operation: { kind: "fields", patch: value } } },
        authority,
      ),
    ).toMatchObject({ kind: "committed" });
  };
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

it("checks current metadata at the effect without sending memory predicates to SQLite", async () => {
  const { binding, patch } = await fixture();
  await runWithSessionActorStorage(binding, async () => {
    const scope = { sessionKey, agentId: binding.agentId, storePath: binding.path };
    const metadata = captureSessionEntryMetadataRead(scope, () =>
      binding.authority.assertCurrent(),
    );
    const assertion = captureSessionEntrySourceAssertion({
      scope,
      expected: metadata?.readCurrent(),
      fields: ["sessionId", "lifecycleRevision", "spawnedCwd"],
      assertCurrent() {},
      refuse() {
        throw new Error("Workspace authority changed");
      },
    });
    const prepared = await assertion.prepareSessionSource();
    expect(prepared.checks).toEqual([]);
    await patch({ label: "Unrelated bookkeeping" });
    expect(() => prepared.assertCurrent()).not.toThrow();
    await patch({ spawnedCwd: "/synthetic/replacement" });
    expect(() => prepared.assertCurrent()).toThrow("Workspace authority changed");
    expect(readGitHubPublicationSession(sessionKey).entry?.spawnedCwd).toBe(
      "/synthetic/replacement",
    );
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
