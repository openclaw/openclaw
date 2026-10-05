import { afterEach, describe, expect, it, vi } from "vitest";
import * as registryReads from "../agents/worktrees/registry-read.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import * as checkout from "../sessions/session-diff.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "./server-methods.js";
import { createHistoryReadContext } from "./server-methods/chat-history.test-helpers.js";
import { sessionsDiffHandlers } from "./server-methods/sessions-diff.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

afterEach(() => vi.restoreAllMocks());

const key = "agent:main:own-review";
const record: ManagedWorktreeRecord = {
  id: "own-worktree",
  name: "own-worktree",
  branch: "session-work",
  baseRef: "main",
  path: "/workspace/session-work",
  repoRoot: "/workspace/repository",
  repoFingerprint: "repository",
  ownerKind: "session",
  ownerId: key,
  createdAt: 1,
  lastActiveAt: 1,
};

async function fixture(options: { owned?: boolean; isolated?: boolean; scopes?: string[] } = {}) {
  const client = roleClient("view", "diff-reader");
  client.connect.scopes = options.scopes ?? ["operator.sessions.read"];
  const entry = {
    sessionId: "review-session",
    updatedAt: 1,
    lifecycleRevision: "original",
    visibility: "shared" as const,
    createdActor: {
      type: "human" as const,
      source: "profile" as const,
      id: options.owned === false ? "another-profile" : client.authenticatedUserProfile!.profileId,
    },
    ...(options.isolated === false
      ? {}
      : {
          spawnedCwd: record.path,
          worktree: { id: record.id, branch: record.branch, repoRoot: record.repoRoot },
        }),
  };
  await upsertSessionEntryCore({ agentId: "main", sessionKey: key }, entry);
  // Projection admission compares snapshot identity across its asynchronous reads.
  const config = rolePolicyConfig();
  const context = await createHistoryReadContext({ getRuntimeConfig: () => config });
  const registry = vi.spyOn(registryReads, "readRegistryWorktree").mockResolvedValue(record);
  vi.spyOn(managedWorktrees, "resolveRepositoryIdentity").mockResolvedValue({
    checkoutRoot: record.path,
    repoRoot: record.repoRoot,
    fingerprint: record.repoFingerprint,
    originUrl: "",
  });
  const io = vi.spyOn(checkout, "loadCheckoutDiff").mockResolvedValue({
    sessionKey: key,
    root: record.path,
    files: [],
    additions: 1,
    deletions: 0,
  });
  const respond = vi.fn();
  let current = true;
  const request = () =>
    handleGatewayRequest({
      req: {
        type: "req",
        id: "own-review",
        method: "sessions.diff",
        params: { sessionKey: key, agentId: "main" },
      },
      client,
      context,
      respond,
      isWebchatConnect: () => false,
      hasCurrentClientAuthority: () => current,
      extraHandlers: sessionsDiffHandlers,
    });
  return {
    client,
    entry,
    registry,
    io,
    respond,
    request,
    revoke: () => {
      current = false;
    },
  };
}

describe("scoped session review", () => {
  it("reads an owned managed checkout against its recorded base without a host path", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const test = await fixture();
      await test.request();
      expect(test.io).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ cwd: record.path, baseRef: "main" }),
      );
      expect(test.respond).toHaveBeenCalledExactlyOnceWith(true, {
        sessionKey: key,
        files: [],
        additions: 1,
        deletions: 0,
      });
    });
  });

  it.each(["foreign", "shared-checkout", "foreign-registry", "removed-worktree"])(
    "rejects %s before reading Git",
    async (kind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const test = await fixture({
          owned: kind !== "foreign",
          isolated: kind !== "shared-checkout",
        });
        if (kind === "foreign-registry") {
          test.registry.mockResolvedValue({ ...record, ownerId: "agent:main:another" });
        }
        if (kind === "removed-worktree") {
          test.registry.mockResolvedValue({ ...record, removedAt: 2 });
        }
        await test.request();
        expect(test.io).not.toHaveBeenCalled();
        expect(test.respond).toHaveBeenCalledOnce();
        expect(test.respond.mock.calls[0]?.[0]).toBe(false);
        expect(test.respond.mock.calls[0]?.[1]).toBeUndefined();
      });
    },
  );

  it.each([1, 3])("rechecks caller authority after registry read %s", async (readNumber) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const test = await fixture();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let reads = 0;
      test.registry.mockImplementation(async () => {
        reads += 1;
        if (reads === readNumber) {
          entered.resolve();
          await release.promise;
        }
        return record;
      });
      const request = test.request();
      const outcome = Promise.allSettled([request]);
      try {
        await Promise.race([entered.promise, request]);
        expect(reads).toBe(readNumber);
        test.revoke();
      } finally {
        release.resolve();
        await outcome;
      }
      expect(test.respond.mock.calls.some(([ok]) => ok === true)).toBe(false);
      if (readNumber === 1) {
        expect(test.io).not.toHaveBeenCalled();
      }
    });
  });

  it.each(["requester", "registry", "session"])(
    "discards an in-flight diff when its %s changes",
    async (change) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const test = await fixture();
        const entered = createDeferredCore();
        const release = createDeferredCore();
        test.io.mockImplementation(async () => {
          entered.resolve();
          await release.promise;
          return { sessionKey: key, root: record.path, files: [], additions: 7, deletions: 0 };
        });
        const request = test.request();
        const outcome = Promise.allSettled([request]);
        try {
          await Promise.race([entered.promise, request]);
          expect(test.io).toHaveBeenCalledOnce();
          if (change === "requester") {
            test.revoke();
          }
          if (change === "registry") {
            test.registry.mockResolvedValue({ ...record, ownerId: "agent:main:replacement" });
          }
          if (change === "session") {
            await upsertSessionEntryCore(
              { agentId: "main", sessionKey: key },
              { ...test.entry, lifecycleRevision: "replacement" },
            );
          }
        } finally {
          release.resolve();
          await outcome;
        }
        expect(test.respond.mock.calls.some(([ok]) => ok === true)).toBe(false);
        expect(JSON.stringify(test.respond.mock.calls)).not.toContain(record.path);
      });
    },
  );

  it("keeps broad read workspace access and redacts narrow filesystem failures", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const test = await fixture({ isolated: false, scopes: ["operator.read"] });
      await test.request();
      expect(test.io).toHaveBeenCalledOnce();
      expect(test.respond.mock.calls[0]?.[0]).toBe(true);
      test.client.connect.scopes = ["operator.sessions.read"];
      test.respond.mockClear();
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        {
          ...test.entry,
          spawnedCwd: record.path,
          worktree: { id: record.id, branch: record.branch, repoRoot: record.repoRoot },
        },
      );
      test.io.mockRejectedValue(new Error(`fatal: unable to read ${record.path}`));
      await test.request();
      expect(test.respond).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE" }),
      );
      expect(JSON.stringify(test.respond.mock.calls)).not.toContain(record.path);
    });
  });
});
