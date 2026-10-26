// @vitest-environment node
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import { createConnectionBootstrapCoordinator } from "../../app/connection-bootstrap.ts";
import {
  allSessions as scope,
  createDeletionHarness as createSessionDeletionHarness,
} from "./deletion-mutation.test-support.ts";
import { sessionsResult } from "./session-capability.test-support.ts";

describe("session deletion generation ownership", () => {
  it.each(["history", "changed", "message"] as const)(
    "rejects an old %s generation before it can replace a rolled-back row",
    async (source) => {
      const h = createSessionDeletionHarness();
      await h.refresh();
      const current = { ...h.alpha, sessionId: "generation-b" };
      await h.refresh([current, h.sibling]);
      const operation = h.sessions.delete(current.key, { expectedSessionId: current.sessionId });
      await h.finish(operation);
      const payload = {
        sessionKey: h.alpha.key,
        reason: "message",
        session: h.alpha,
        hasActiveRun: false,
      };
      if (source === "history") {
        h.sessions.reconcile(h.alpha);
      } else if (source === "changed") {
        h.changed(payload);
      } else {
        h.message(payload);
      }
      expect(h.rows()).toEqual([current, h.sibling]);
    },
  );

  it("uses the admitted bootstrap list to establish a fresh replacement", async () => {
    const coordinator = createConnectionBootstrapCoordinator();
    const h = createSessionDeletionHarness(coordinator);
    const synchronize = () =>
      coordinator.synchronize({
        client: h.gateway.snapshot.client,
        connected: h.gateway.snapshot.phase === "connected",
      });
    synchronize();
    const stop = h.gateway.subscribe(synchronize);
    onTestFinished(() => {
      stop();
      coordinator.reset();
    });
    await h.refresh();
    h.publish(false);
    coordinator.setForegroundRoute(undefined);
    h.publish(true);
    const operation = h.sessions.delete(h.alpha.key, { expectedSessionId: h.alpha.sessionId });
    await vi.waitFor(() => expect(h.responses.has(h.alpha.key)).toBe(true));
    const replacement = { ...h.alpha, sessionId: "replacement-after-admission" };
    h.setRows([replacement, h.sibling]);
    coordinator.setForegroundRoute(null);
    await vi.waitFor(() => expect(h.rows()).toContainEqual(replacement));
    expect(h.sessions.deletionState(h.alpha.key)).toBeUndefined();
    await h.finish(operation, h.alpha.key, true);
    expect(h.rows()).toContainEqual(replacement);
  });

  it.each(["managed", "enumeration"] as const)(
    "keeps a fresh replacement ahead of a slower post-admission %s generation",
    async (source) => {
      const h = createSessionDeletionHarness();
      const older = h.deferredList();
      h.hold();
      const facts: string[] = [];
      h.sessions.subscribe((state) => facts.push(...state.deletedSessions.map(({ key }) => key)));
      await h.refresh();
      const operation = h.sessions.delete(h.alpha.key, { expectedSessionId: h.alpha.sessionId });
      await h.waitForDeleteRequest(h.alpha.key);
      h.setListResponse(older.promise);
      const stale = h.read(source);
      h.setListResponse();
      const replacement = { ...h.alpha, sessionId: "newest-generation" };
      await h.refresh([replacement, h.sibling]);
      older.resolve(sessionsResult([{ ...h.alpha, sessionId: "intermediate-generation" }], 1));
      expect((await stale)?.sessions).toEqual([]);
      await h.finish(operation, h.alpha.key, true);
      expect(facts).toEqual([]);
      expect(h.rows()).toContainEqual(replacement);
    },
  );

  it.each([
    { source: "primary", outcome: "confirmed", afterSettlement: false },
    { source: "primary", outcome: "rejected", afterSettlement: false },
    { source: "primary", outcome: "confirmed", afterSettlement: true },
    { source: "primary", outcome: "rejected", afterSettlement: true },
    { source: "bootstrap", outcome: "rejected", afterSettlement: true },
    { source: "managed", outcome: "confirmed", afterSettlement: false },
    { source: "enumeration", outcome: "rejected", afterSettlement: false },
  ] as const)(
    "fences older $source A while B is $outcome (delivery after settlement: $afterSettlement)",
    async ({ source, outcome, afterSettlement }) => {
      const h = createSessionDeletionHarness();
      const older = h.deferredList();
      const publishedIds: Array<string | undefined> = [];
      h.hold(scope, ({ result }) => {
        publishedIds.push(...(result?.sessions.map((row) => row.sessionId) ?? []));
      });
      const facts: string[] = [];
      h.sessions.subscribe((state) => {
        publishedIds.push(...(state.result?.sessions.map((row) => row.sessionId) ?? []));
        facts.push(...state.deletedSessions.map(({ key }) => key));
      });
      h.setRows([h.sibling]);
      let stale: Promise<SessionsListResult | null>;
      if (source === "bootstrap") {
        h.request.mockImplementationOnce(async () => ({
          subscribed: true,
          list: await older.promise,
        }));
        h.publish(true);
        stale = vi
          .waitFor(() => expect(h.sessions.state.result).not.toBeNull())
          .then(() => h.sessions.state.result);
      } else {
        await h.refresh();
        h.setListResponse(older.promise);
        stale = h.read(source);
      }
      h.setListResponse();
      const current = { ...h.alpha, sessionId: "generation-b" };
      h.setRows([current, h.sibling]);
      const currentScope = source === "primary" || source === "bootstrap" ? scope : {};
      await h.sessions.refreshList(
        source === "primary" || source === "bootstrap" ? scope : { force: true },
      );
      const operation = h.sessions.delete(current.key, { expectedSessionId: current.sessionId });
      const settled = operation.then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );
      expect(h.sessions.deletionState(current.key)).toBe("pending");
      const response = await h.waitForDeleteRequest(current.key);
      h.setRows(outcome === "confirmed" ? [h.sibling] : [current, h.sibling]);
      const settle = () =>
        outcome === "confirmed"
          ? response.resolve({ deleted: true })
          : response.reject(new Error("reclaim failed"));
      if (afterSettlement) {
        settle();
        await vi.waitFor(() => expect(h.sessions.deletionState(current.key)).not.toBe("pending"));
      }
      older.resolve(sessionsResult([h.alpha, h.sibling], 1));
      expect((await stale)?.sessions).not.toContainEqual(h.alpha);
      if (!afterSettlement) {
        expect(h.sessions.deletionState(current.key)).toBe("pending");
        settle();
      }
      const result = await settled;
      expect(outcome === "confirmed" ? result.value : result.error).toEqual(
        outcome === "confirmed" ? { deleted: true } : new Error("reclaim failed"),
      );
      expect(publishedIds).not.toContain(h.alpha.sessionId);
      expect(facts.includes(current.key)).toBe(outcome === "confirmed");
      if (outcome === "rejected") {
        expect(h.sessions.listSnapshot(currentScope).result?.sessions).toContainEqual(current);
      }
    },
  );

  it.each(["primary", "managed"] as const)(
    "keeps cached %s and history generations from retiring the current deletion",
    async (cached) => {
      const h = createSessionDeletionHarness();
      h.hold();
      h.setRows([h.alpha, h.sibling]);
      await h.sessions.refreshList(cached === "managed" ? scope : { force: true });
      const current = { ...h.alpha, sessionId: "generation-b" };
      h.setRows([current, h.sibling]);
      const currentScope = cached === "managed" ? {} : scope;
      await h.sessions.refreshList({ ...currentScope, force: true });
      const operation = h.sessions.delete(current.key, { expectedSessionId: current.sessionId });
      h.sessions.reconcile(h.alpha);
      h.changed({ ...h.alpha, sessionKey: h.alpha.key, reason: "send" });
      h.message({ session: h.alpha, hasActiveRun: false });
      expect(h.sessions.deletionState(current.key)).toBe("pending");
      expect(h.rows()).toEqual([h.sibling]);
      expect(h.sessions.listSnapshot(scope).result?.sessions).not.toContainEqual(h.alpha);
      await h.finish(operation);
      expect(h.sessions.listSnapshot(currentScope).result?.sessions).toContainEqual(current);
      expect(h.sessions.listSnapshot(scope).result?.sessions).not.toContainEqual(h.alpha);
    },
  );

  it.each(["bootstrap", "primary", "managed", "enumeration"] as const)(
    "resolves an unloaded deletion from fresh %s membership after reconnect",
    async (kind) => {
      const h = createSessionDeletionHarness();
      h.hold();
      await h.refresh([h.sibling]);
      const { key: sessionKey, sessionId } = h.alpha;
      h.changed({ sessionKey, reason: "delete", sessionId, agentId: "main" });
      expect(h.sessions.deletionState(h.alpha.key)).toBe("confirmed");
      h.publish(false);
      const replacement = { ...h.alpha, sessionId: "replacement-alpha" };
      if (kind === "bootstrap") {
        h.setRows([replacement, h.sibling]);
      }
      h.publish(true);
      await vi.waitFor(() => expect(h.sessions.state.result).not.toBeNull());
      if (kind === "bootstrap") {
        expect(h.rows()).toContainEqual(replacement);
        expect(h.sessions.deletionState(h.alpha.key)).toBeUndefined();
        return;
      }
      h.setRows([replacement, h.sibling]);
      expect((await h.read(kind, scope, true))?.sessions).toContainEqual(replacement);
      expect(h.sessions.deletionState(h.alpha.key)).toBeUndefined();
    },
  );

  it.each(["primary", "managed", "enumeration"] as const)(
    "keeps pre-delete %s responses fenced after fresh membership resolves an unloaded deletion",
    async (kind) => {
      const h = createSessionDeletionHarness();
      const staleList = h.deferredList();
      h.hold();
      await h.refresh([h.sibling]);
      h.setListResponse(staleList.promise);
      const stale = h.read(kind, scope);
      const { key: sessionKey, sessionId } = h.alpha;
      h.changed({ sessionKey, reason: "delete", sessionId, agentId: "main" });
      const replacement = { ...h.alpha, sessionId: "replacement-alpha" };
      h.setListResponse();
      h.setRows([replacement, h.sibling]);
      expect((await h.sessions.list())?.sessions).toContainEqual(replacement);
      staleList.resolve(sessionsResult([h.alpha, h.sibling], 1));
      const result = await stale;
      expect(result?.sessions).not.toContainEqual(h.alpha);
      expect(h.sessions.deletionState(h.alpha.key)).toBeUndefined();
    },
  );

  it.each(["confirmed", "rejected"] as const)(
    "retains retired generations while a successor deletion is %s",
    async (outcome) => {
      const h = createSessionDeletionHarness();
      await h.refresh();
      const first = h.sessions.delete(h.alpha.key, { expectedSessionId: h.alpha.sessionId });
      const firstResponse = await h.waitForDeleteRequest(h.alpha.key);
      h.setRows([h.sibling]);
      await h.finish(first, h.alpha.key, true);
      const replacement = { ...h.alpha, sessionId: "replacement-alpha" };
      await h.refresh([replacement, h.sibling]);
      const facts: string[] = [];
      h.sessions.subscribe((state) => facts.push(...state.deletedSessions.map(({ key }) => key)));
      const next = h.sessions.delete(h.alpha.key, { expectedSessionId: replacement.sessionId });
      const nextResponse = await h.waitForDeleteRequest(h.alpha.key, firstResponse);
      await h.refresh([h.alpha, h.sibling]);
      expect(h.rows()).not.toContainEqual(h.alpha);
      expect(h.sessions.deletionState(h.alpha.key)).toBe("pending");
      expect(h.sessions.deletionState(h.alpha.key, "main", h.alpha.sessionId)).toBe("confirmed");
      h.setRows(outcome === "confirmed" ? [h.sibling] : [replacement, h.sibling]);
      const settled =
        outcome === "confirmed"
          ? expect(next).resolves.toEqual({ deleted: true })
          : expect(next).rejects.toThrow("successor reclaim failed");
      if (outcome === "confirmed") {
        nextResponse.resolve({ deleted: true });
      } else {
        nextResponse.reject(new Error("successor reclaim failed"));
      }
      await settled;
      expect(facts.includes(h.alpha.key)).toBe(outcome === "confirmed");
      await h.refresh([h.alpha, h.sibling]);
      expect(h.rows()).not.toContainEqual(h.alpha);
    },
  );
});
