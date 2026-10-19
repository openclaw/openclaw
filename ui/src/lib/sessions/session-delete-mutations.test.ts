// @vitest-environment node
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  GatewayRequestError,
  type GatewayBrowserClient,
  type GatewayHelloOk,
} from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { formatUiError } from "../format-error.ts";
import { sessionsResult } from "./session-capability.test-support.ts";
import { createSessionDeletionHarness as createDeletionHarness } from "./session-deletion.test-support.ts";

function createSessionDeletionHarness(...args: Parameters<typeof createDeletionHarness>) {
  const h = createDeletionHarness(...args);
  onTestFinished(() => {
    h.responses.forEach((response) => response.resolve({ deleted: false }));
    h.sessions.dispose();
  });
  return {
    ...h,
    rows: () => h.sessions.state.result?.sessions,
    keys: () => h.sessions.state.result?.sessions.map(({ key }) => key),
  };
}

describe("optimistic session deletion", () => {
  it.each(["single", "batch"] as const)(
    "preserves the recovery error and target through a %s deletion",
    async (mode) => {
      const h = createSessionDeletionHarness();
      const target = {
        key: h.alpha.key,
        agentId: "main",
        expectedSessionId: h.alpha.sessionId,
        deleteTranscript: true,
      };
      const error = new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Reconnect the device or continue on the Gateway.",
        details: {
          code: "SESSION_WORKSPACE_RECOVERY_REQUIRED",
          cause: "device_offline",
          recoveryAction: "continue_on_gateway",
          sessionId: h.alpha.sessionId,
          source: { generation: 5, environmentId: "device-environment", ownerEpoch: 70 },
        },
      });
      try {
        await h.sessions.refresh({ force: true });
        const operation =
          mode === "single"
            ? h.sessions.delete(target.key, target)
            : h.sessions.deleteMany([target]);
        const settled =
          mode === "single"
            ? expect(operation).rejects.toBe(error)
            : expect(operation).resolves.toEqual({
                deleted: [],
                errors: [{ target, error }],
                preservedWorktrees: [],
              });
        h.responses.get(target.key)!.reject(error);
        await settled;
        expect(h.sessions.deletionState(target.key)).toBeUndefined();
        expect(h.sessions.state.result?.sessions).toContainEqual(h.alpha);
      } finally {
        h.responses.get(target.key)?.resolve({ deleted: false });
        h.sessions.dispose();
      }
    },
  );

  it.each([
    { firstKey: "main", firstMode: "single", secondMode: "batch" },
    { firstKey: "agent:main:main", firstMode: "batch", secondMode: "single" },
  ] as const)(
    "returns caller keys when $firstMode $firstKey shares its deletion with a $secondMode alias",
    async ({ firstKey, firstMode, secondMode }) => {
      const h = createSessionDeletionHarness();
      h.gateway.snapshot.hello = {
        type: "hello-ok",
        protocol: 4,
        auth: { role: "operator", scopes: [] },
        snapshot: {
          sessionDefaults: {
            defaultAgentId: "main",
            mainKey: "main",
            mainSessionKey: "agent:main:main",
            scope: "per-sender",
          },
        },
      };
      const secondKey = firstKey === "main" ? "agent:main:main" : "main";
      const expectedSessionId = "main-id";
      const worktreePreserved = {
        id: "worktree",
        branch: "feature",
        path: "/tmp/worktree",
        reason: "busy" as const,
      };
      const run = (mode: "single" | "batch", keys: string[]) =>
        mode === "single"
          ? h.sessions.delete(keys[0]!, { expectedSessionId }).then((outcome) => ({
              deleted: outcome.deleted ? keys : [],
              preservedWorktrees: outcome.worktreePreserved ? [outcome.worktreePreserved] : [],
            }))
          : h.sessions.deleteMany(keys.map((key) => ({ key, expectedSessionId })));
      h.setRows([{ ...h.alpha, key: "agent:main:main", sessionId: expectedSessionId }]);
      await h.sessions.refresh({ force: true });
      const firstKeys = firstMode === "single" ? [firstKey] : [firstKey, secondKey, firstKey];
      const secondKeys = secondMode === "single" ? [secondKey] : [secondKey, secondKey];
      const first = run(firstMode, firstKeys);
      const second = run(secondMode, secondKeys);
      expect(h.request.mock.calls.filter(([method]) => method === "sessions.delete")).toHaveLength(
        1,
      );
      h.setRows([]);
      h.responses.get(firstKey)!.resolve({ deleted: true, worktreePreserved });
      expect(await first).toMatchObject({
        deleted: [...new Set(firstKeys)],
        preservedWorktrees: [worktreePreserved],
      });
      expect(await second).toMatchObject({
        deleted: [secondKey],
        preservedWorktrees: [worktreePreserved],
      });
    },
  );

  it.each(["rejection", "no-op"] as const)(
    "reconciles canonical rosters after a %s without claiming server rollback",
    async (outcome) => {
      vi.useFakeTimers();
      const h = createSessionDeletionHarness();
      const scope = { archivedFilter: "all" as const };
      const stop = h.sessions.subscribeList(scope, () => {});
      onTestFinished(() => {
        stop();
        vi.useRealTimers();
      });
      await h.sessions.refresh({ force: true });
      await h.sessions.refreshList(scope);
      const operation = h.sessions.delete(h.alpha.key);
      const settled =
        outcome === "rejection"
          ? expect(operation).rejects.toThrow("postcommit cleanup failed")
          : expect(operation).resolves.toEqual({ deleted: false });
      h.setRows([h.beta, h.sibling]);
      if (outcome === "rejection") {
        h.responses.get(h.alpha.key)!.reject(new Error("postcommit cleanup failed"));
      } else {
        h.responses.get(h.alpha.key)!.resolve({ deleted: false });
      }
      await settled;
      expect(h.sessions.state.deletedSessions).toEqual([]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.rows()).toEqual([h.beta, h.sibling]);
      expect(h.sessions.listSnapshot(scope).result?.sessions).toEqual([h.beta, h.sibling]);
    },
  );

  it("lets an unloaded local RPC confirm without trusting a key-only event", async () => {
    const h = createSessionDeletionHarness();
    const facts: string[] = [];
    h.sessions.subscribe((state) => facts.push(...state.deletedSessions.map(({ key }) => key)));
    h.setRows([h.sibling]);
    await h.sessions.refresh({ force: true });
    const deletion = h.sessions.delete(h.alpha.key);
    h.emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: h.alpha.key,
        agentId: "main",
        reason: "delete",
      },
    });
    expect(h.sessions.deletionState(h.alpha.key)).toBe("pending");
    expect(facts).toEqual([]);
    h.responses.get(h.alpha.key)!.resolve({ deleted: true });
    await deletion;
    expect(h.sessions.deletionState(h.alpha.key)).toBe("confirmed");
    expect(facts).toContain(h.alpha.key);
  });

  it("recognizes global aliases without crossing the selected agent", async () => {
    const h = createSessionDeletionHarness();
    h.gateway.snapshot.hello = {
      snapshot: {
        sessionDefaults: {
          defaultAgentId: "ops",
          mainKey: "home",
          mainSessionKey: "global",
        },
      },
    } as GatewayHelloOk;
    h.gateway.snapshot.assistantAgentId = "work";
    const operation = h.sessions.delete("global", {
      agentId: "work",
      expectedSessionId: "work-global",
    });
    expect(h.sessions.deletionState("agent:work:home")).toBe("pending");
    expect(h.sessions.deletionState("global", "ops")).toBeUndefined();
    h.responses.get("global")!.resolve({ deleted: false });
    await operation;
  });

  it.each([
    { scope: "agent", targetKey: "main", targetAgent: "ops", expectedId: "old", pending: false },
    {
      scope: "global",
      targetKey: "agent:work:home",
      targetAgent: "work",
      expectedId: "old",
      pending: false,
    },
    {
      scope: "global",
      targetKey: "global",
      targetAgent: "work",
      expectedId: "current",
      pending: true,
    },
  ])(
    "admits only the published generation through $scope alias $targetKey",
    async ({ scope, targetKey, targetAgent, expectedId, pending }) => {
      const h = createSessionDeletionHarness();
      h.gateway.snapshot.hello = {
        snapshot: {
          sessionDefaults: {
            defaultAgentId: "ops",
            mainKey: "home",
            mainSessionKey: scope === "global" ? "global" : "agent:ops:home",
          },
        },
      } as GatewayHelloOk;
      h.gateway.snapshot.assistantAgentId = "work";
      const current = {
        ...h.alpha,
        key: scope === "global" ? "global" : "agent:ops:home",
        agentId: targetAgent,
        sessionId: "current",
      };
      const other = { ...current, agentId: "ops", sessionId: "other-agent" };
      const signals: Array<"pending" | "confirmed" | undefined> = [];
      h.setRows(scope === "global" ? [other, current] : [current]);
      await h.sessions.refresh({ force: true });
      h.sessions.subscribe(() => signals.push(h.sessions.deletionState(current.key, targetAgent)));
      const operation = h.sessions.delete(targetKey, {
        agentId: targetAgent,
        expectedSessionId: expectedId,
      });
      expect(signals.includes("pending")).toBe(pending);
      if (scope === "global") {
        expect(h.sessions.deletionState("global", "ops")).toBeUndefined();
        expect(h.rows()).toContainEqual(other);
      }
      h.responses.get(targetKey)!.resolve({ deleted: false });
      await operation;
      expect(h.rows()).toContainEqual(current);
    },
  );

  it("rolls back only the managed window that actually lost the row", async () => {
    const h = createSessionDeletionHarness();
    const smaller = { archivedFilter: "all" as const, limit: 1 };
    const larger = { ...smaller, limit: 2 };
    const stops = [smaller, larger].map((scope) => h.sessions.subscribeList(scope, () => {}));
    onTestFinished(() => {
      stops.forEach((stop) => stop());
    });
    await h.sessions.refreshList(smaller);
    await h.sessions.refreshList(larger);
    const operation = h.sessions.delete(h.beta.key);
    const rejected = expect(operation).rejects.toThrow("reclaim failed");
    expect(h.sessions.listSnapshot(larger).result?.sessions).toEqual([h.alpha]);
    h.responses.get(h.beta.key)!.reject(new Error("reclaim failed"));
    await rejected;
    expect(h.sessions.listSnapshot(smaller).result).toMatchObject({
      sessions: [h.alpha],
      count: 1,
      totalCount: 3,
    });
    expect(h.sessions.listSnapshot(larger).result).toMatchObject({
      sessions: [h.alpha, h.beta],
      count: 2,
      totalCount: 3,
    });
  });

  it("keeps held rollback positions separate from one-shot enumeration", async () => {
    const h = createSessionDeletionHarness();
    const scope = { archivedFilter: "all" as const, limit: 2 };
    const stop = h.sessions.subscribeList(scope, () => {});
    onTestFinished(stop);
    await h.sessions.refreshList(scope);
    const operation = h.sessions.delete(h.beta.key);
    h.setRows([h.beta, h.alpha, h.sibling]);
    await h.sessions.list(scope);
    h.responses.get(h.beta.key)!.resolve({ deleted: false });
    await operation;
    expect(h.sessions.listSnapshot(scope).result?.sessions).toEqual([h.alpha, h.beta]);
  });

  it("does not restore an old window into its released and recreated owner", async () => {
    const h = createSessionDeletionHarness();
    const scope = { archivedFilter: "all" as const, limit: 2 };
    let stop = h.sessions.subscribeList(scope, () => {});
    onTestFinished(() => stop());
    await h.sessions.refreshList(scope);
    const operation = h.sessions.delete(h.beta.key);
    stop();
    stop = h.sessions.subscribeList(scope, () => {});
    h.setRows([h.sibling]);
    await h.sessions.refreshList(scope);
    h.responses.get(h.beta.key)!.resolve({ deleted: false });
    await operation;
    expect(h.sessions.listSnapshot(scope).result).toMatchObject({
      sessions: [h.sibling],
      count: 1,
      totalCount: 1,
    });
  });

  it.each(["primary", "managed"] as const)("retains %s rollback through append", async (kind) => {
    const h = createSessionDeletionHarness();
    const scope = { limit: 2, ...(kind === "managed" ? { archivedFilter: "all" as const } : {}) };
    const stop = h.sessions.subscribeList(scope, () => {});
    onTestFinished(stop);
    await h.sessions.refreshList(scope);
    const operation = h.sessions.delete(h.beta.key);
    await h.sessions.refreshList({ ...scope, offset: 2, append: true });
    h.responses.get(h.beta.key)!.resolve({ deleted: false });
    await operation;
    expect(h.sessions.listSnapshot(scope).result).toMatchObject({
      sessions: [h.alpha, h.beta, h.sibling],
      count: 3,
      totalCount: 3,
    });
  });

  it("does not restore a primary row after the query changes its limit", async () => {
    const h = createSessionDeletionHarness();
    await h.sessions.refresh({ limit: 2, force: true });
    const operation = h.sessions.delete(h.beta.key);
    await h.sessions.refresh({ limit: 1, force: true });
    h.responses.get(h.beta.key)!.resolve({ deleted: false });
    await operation;
    expect(h.sessions.state.result).toMatchObject({
      sessions: [h.alpha],
      count: 1,
      totalCount: 3,
    });
  });

  it("does not restore an old generation into another held list after seeing its replacement", async () => {
    const h = createSessionDeletionHarness();
    const scope = { archivedFilter: "all" as const };
    const stop = h.sessions.subscribeList(scope, () => {});
    onTestFinished(stop);
    await h.sessions.refresh({ force: true });
    await h.sessions.refreshList(scope);
    const operation = h.sessions.delete(h.beta.key);
    const replacement = { ...h.beta, sessionId: "replacement-beta" };
    h.setRows([h.alpha, replacement, h.sibling]);
    await h.sessions.refresh({ force: true });
    h.responses.get(h.beta.key)!.resolve({ deleted: false });
    await operation;
    expect(h.rows()).toContainEqual(replacement);
    expect(h.sessions.listSnapshot(scope).result?.sessions).toEqual([h.alpha, h.sibling]);
  });

  it("shares an overlapping delete and restores lifecycle no-ops without deleting drafts", async () => {
    const h = createSessionDeletionHarness();
    await h.sessions.refresh({ force: true });
    const facts: string[] = [];
    h.sessions.subscribe((state) => {
      facts.push(...state.deletedSessions.map((fact) => fact.key));
    });
    const first = h.sessions.delete(h.alpha.key);
    const second = h.sessions.deleteMany([{ key: h.alpha.key }]);
    expect(h.request.mock.calls.filter(([method]) => method === "sessions.delete")).toHaveLength(1);
    expect(h.sessions.deletionState(h.alpha.key)).toBe("pending");
    h.responses.get(h.alpha.key)!.resolve({ deleted: false });
    await expect(first).resolves.toEqual({ deleted: false });
    await expect(second).resolves.toMatchObject({ deleted: [] });
    expect(h.rows()).toEqual([h.alpha, h.beta, h.sibling]);
    expect(facts).toEqual([]);
  });

  it("preserves a replacement identity and rejects delayed rows from the deleted identity", async () => {
    const h = createSessionDeletionHarness();
    await h.sessions.refresh({ force: true });
    const operation = h.sessions.delete(h.alpha.key, { expectedSessionId: h.alpha.sessionId });
    const replacement = { ...h.alpha, sessionId: "replacement", label: "New thread" };
    h.setRows([replacement, h.beta, h.sibling]);
    await h.sessions.refresh({ force: true });
    expect(h.rows()?.[0]).toEqual(replacement);
    expect(h.sessions.deletionState(h.alpha.key)).toBeUndefined();
    h.responses.get(h.alpha.key)!.resolve({ deleted: true });
    await operation;
    expect(h.rows()?.[0]).toEqual(replacement);
    h.setRows([h.alpha, h.beta, h.sibling]);
    await h.sessions.refresh({ force: true });
    expect(h.keys()).not.toContain(h.alpha.key);
  });

  it.each([false, true])(
    "cancels unsent batch members after reconnect (client replaced: %s)",
    async (replaceClient) => {
      const h = createSessionDeletionHarness();
      await h.sessions.refresh({ force: true });
      const errors: string[] = [];
      h.sessions.subscribe((state) => {
        if (state.error) {
          errors.push(state.error);
        }
      });
      const operation = h.sessions.deleteMany([{ key: h.alpha.key }, { key: h.beta.key }]);
      h.publish(false);
      h.publish(
        true,
        replaceClient
          ? ({ request: h.request } as unknown as GatewayBrowserClient)
          : h.gateway.snapshot.client,
      );
      h.responses.get(h.alpha.key)!.resolve({ deleted: true });
      const result = await operation;
      expect(result.deleted).toEqual(replaceClient ? [] : [h.alpha.key]);
      if (replaceClient) {
        expect(errors).toEqual([]);
      } else {
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]?.target).toEqual({ key: h.beta.key });
        expect(errors).toContain(formatUiError(result.errors[0]?.error));
      }
      expect(h.responses.has(h.beta.key)).toBe(false);
      await h.sessions.refresh({ force: true });
      expect(h.keys()).toContain(h.beta.key);
    },
  );

  it.each(["single", "batch"] as const)(
    "%s removes all selected rows before any delete response and fences stale list/event publications",
    async (mode) => {
      const h = createSessionDeletionHarness();
      const filtered = { agentId: "main", archivedFilter: "all" as const };
      const stop = h.sessions.subscribeList(filtered, () => undefined);
      onTestFinished(stop);
      await h.sessions.refresh({ force: true });
      await h.sessions.refreshList(filtered);
      const targets = mode === "single" ? [h.alpha] : [h.alpha, h.beta];
      const staleList = createDeferred<SessionsListResult>();
      h.setListResponse(staleList.promise);
      const refresh = h.sessions.refresh({ force: true });
      const operation =
        mode === "single"
          ? h.sessions.delete(h.alpha.key)
          : h.sessions.deleteMany(targets.map(({ key }) => ({ key })));
      const assertRemoved = () => {
        for (const target of targets) {
          expect(h.keys()).not.toContain(target.key);
          expect(
            h.sessions.listSnapshot(filtered).result?.sessions.map(({ key }) => key),
          ).not.toContain(target.key);
        }
      };
      assertRemoved();
      for (const target of targets) {
        h.emitEvent({
          type: "event",
          event: "sessions.changed",
          payload: { sessionKey: target.key, reason: "send", ...target },
        });
        h.emitEvent({
          type: "event",
          event: "session.message",
          payload: {
            sessionKey: target.key,
            reason: "message",
            session: target,
            hasActiveRun: false,
          },
        });
      }
      staleList.resolve(sessionsResult([h.alpha, h.beta, h.sibling], 1));
      h.setListResponse();
      await refresh;
      assertRemoved();
      for (const target of targets) {
        await vi.waitFor(() => expect(h.responses.has(target.key)).toBe(true));
        h.responses.get(target.key)!.resolve({ deleted: true });
      }
      await operation;
      await h.sessions.refreshList({ ...filtered, force: true });
      assertRemoved();
      expect((await h.sessions.list())?.sessions.map(({ key }) => key)).not.toContain(h.alpha.key);
    },
  );

  it("rolls back only the failed row while preserving a concurrent deletion and unrelated edits", async () => {
    const h = createSessionDeletionHarness();
    const filtered = { archivedFilter: "all" as const };
    const stop = h.sessions.subscribeList(filtered, () => undefined);
    onTestFinished(stop);
    await h.sessions.refresh({ force: true });
    await h.sessions.refreshList(filtered);
    const alpha = h.sessions.delete(h.alpha.key);
    const rejection = expect(alpha).rejects.toThrow("cloud cleanup failed");
    const beta = h.sessions.delete(h.beta.key);
    expect(h.rows()).toEqual([h.sibling]);
    h.sessions.patchRowLocal(
      h.sibling.key,
      { label: "new sibling name" },
      {
        agentId: "main",
        sessionId: h.sibling.sessionId!,
      },
    );
    h.responses.get(h.alpha.key)!.reject(new Error("cloud cleanup failed"));
    await rejection;
    expect(h.rows()).toEqual([h.alpha, { ...h.sibling, label: "new sibling name" }]);
    expect(h.sessions.listSnapshot(filtered).result?.sessions).toEqual([
      h.alpha,
      { ...h.sibling, label: "new sibling name" },
    ]);
    expect(h.sessions.state.error).toContain("cloud cleanup failed");
    h.setRows([h.alpha, { ...h.sibling, label: "new sibling name" }]);
    h.responses.get(h.beta.key)!.resolve({ deleted: true });
    await beta;
    expect(h.keys()).toEqual([h.alpha.key, h.sibling.key]);
  });

  it("keeps pending deletion hidden through a same-client reconnect", async () => {
    const h = createSessionDeletionHarness();
    await h.sessions.refresh({ force: true });
    const operation = h.sessions.delete(h.alpha.key);
    h.publish(false);
    h.publish(true);
    await h.sessions.refresh({ force: true });
    expect(h.keys()).not.toContain(h.alpha.key);
    h.responses.get(h.alpha.key)!.resolve({ deleted: true });
    await operation;
    expect(h.keys()).not.toContain(h.alpha.key);
  });
});
