import { afterAll, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.transcript-turn.js";
import { registerAgentRunContext, clearAgentRunContext } from "../infra/agent-run-registry.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createFixture, sessionKey } from "./control-ui-session-pr-access.test-support.js";
import { createRequestGatewayMethodRegistry } from "./server-methods.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { publishTranscriptFields } from "./session-row-projection-record.js";

type Fixture = Awaited<ReturnType<typeof createFixture>>;
let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
const runtime = createPluginRuntime();

afterAll(async () => {
  await state?.cleanup();
});

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  state ??= await createOpenClawTestState({ scenario: "minimal" });
  state.applyEnv();
  const work = new AsyncWorkScope();
  let fixture: Fixture | undefined;
  try {
    await work.track(async () => {
      fixture = await createFixture("operator.read", false, {
        worktree: { id: "facts-worktree", branch: "change", repoRoot: "/synthetic/repository" },
        label: "Review the change",
        lifecycleRevision: "current-generation",
        status: "done",
        lastActivityAt: 1,
        observerDigest: {
          sessionKey,
          headline: "Ready for review",
          assessment: "The change is complete and awaits review.",
          health: "done",
          revision: 3,
          updatedAt: 10,
        },
      });
      const methodRegistry = createRequestGatewayMethodRegistry();
      fixture.context.getGatewayMethodRegistry = () => methodRegistry;
      try {
        await run(fixture);
      } finally {
        await fixture.close();
      }
    });
  } finally {
    try {
      await work.drain();
    } finally {
      await fixture?.removeSessions();
    }
  }
}

function read(fixture: Fixture, sessionKeys: readonly string[]) {
  return withPluginRuntimeGatewayRequestScope(
    {
      context: fixture.context,
      client: fixture.client,
      isWebchatConnect: () => false,
      pluginId: "workboard",
      pluginOrigin: "bundled",
    },
    () => runtime.gateway.readSessionFacts({ sessionKeys }),
  );
}

describe("trusted plugin session facts", () => {
  it("subscribes to narrow keyed invalidations until unsubscribed", () => {
    const listener = vi.fn();
    const unsubscribe = runtime.gateway.subscribeSessionChanges(listener);
    try {
      sessionChanges.emit({
        agentId: "main",
        sessionKey,
        storePath: "/synthetic/private/store",
        facts: { kind: "removed" },
        factsInvalidated: "category",
      });
      sessionChanges.emit({
        sessionKey,
        facts: { kind: "category", sessionId: "session-category", category: "work" },
      });
      sessionChanges.emit({
        sessionKey,
        facts: { kind: "category", sessionId: "session-category", category: "work" },
        factsInvalidated: true,
      });
      sessionChanges.emit({ sessionKey, factsInvalidated: true });
      sessionChanges.emit({ agentId: "main", sessionKey });
      sessionChanges.emit({ all: true, scope: "stores", factsInvalidated: true });
      expect(listener.mock.calls).toEqual([
        [{ agentId: "main", sessionKey, factsInvalidated: "category" }],
        [{ agentId: "main", sessionKey, factsInvalidated: "category" }],
        [{ agentId: "main", sessionKey, factsInvalidated: "true" }],
        [{ agentId: "main", sessionKey, factsInvalidated: "true" }],
        [{ agentId: "main", sessionKey }],
      ]);
      unsubscribe();
      sessionChanges.emit({ agentId: "main", sessionKey });
      expect(listener).toHaveBeenCalledTimes(5);
    } finally {
      unsubscribe();
    }
  });

  it("lists shared sessions as a trusted service while retaining a scoped client's visibility", () =>
    withFixture(async (fixture) => {
      const foreignKey = "agent:main:foreign-shared";
      const incognitoKey = "agent:main:dashboard:incognito-service-roster";
      await fixture.seed(foreignKey, fixture.other.id, { visibility: "shared" });
      await fixture.seed(incognitoKey, fixture.profile.id, { incognito: true });
      setRuntimeConfigSnapshot({
        gateway: {
          roles: {
            default: "reader",
            definitions: {
              reader: {
                agents: ["main"],
                sessions: { others: "none" },
                scopes: ["operator.read"],
              },
            },
          },
        },
      });
      const list = (client?: Fixture["client"]) =>
        withPluginRuntimeGatewayRequestScope(
          {
            context: fixture.context,
            client,
            isWebchatConnect: () => false,
            pluginId: "workboard",
            pluginOrigin: "bundled",
          },
          () =>
            runtime.gateway.request<{ sessions: Array<{ key: string }> }>(
              "sessions.list",
              {
                configuredAgentsOnly: true,
                includeGlobal: false,
                includeUnknown: false,
                archived: false,
              },
              { scopes: ["operator.read"] },
            ),
        );
      expect((await list()).sessions.map(({ key }) => key).toSorted()).toEqual(
        [sessionKey, foreignKey].toSorted(),
      );
      expect((await list(fixture.client)).sessions.map(({ key }) => key)).toEqual([sessionKey]);
    }));

  it("projects admitted session identity, trajectory and canonical PR states", () =>
    withFixture(async (fixture) => {
      const privateKey = "agent:main:private-change";
      const queuedKey = "agent:main:queued-change";
      await fixture.seed(privateKey, fixture.other.id, { visibility: "draft" });
      await fixture.seed(queuedKey, fixture.profile.id, {
        status: "queued",
        worktree: { id: "queued-worktree", branch: "queued", repoRoot: "/synthetic/repository" },
      });
      fixture.load.mockResolvedValueOnce({
        pullRequests: [
          {
            number: 27,
            owner: "synthetic",
            repo: "project",
            title: "Change",
            branch: "change",
            url: "https://github.com/synthetic/project/pull/27",
            state: "merged",
          },
        ],
        rateLimited: false,
      });
      await fixture.subscriptions.replace(fixture.client.connId, [sessionKey, queuedKey]);
      const result = await read(fixture, [
        sessionKey,
        sessionKey,
        privateKey,
        queuedKey,
        "agent:main:absent",
      ]);
      expect(result.sessions).toHaveLength(2);
      expect(result).toMatchObject({
        sessions: [
          {
            key: sessionKey,
            sessionId: fixture.sessionId,
            lifecycleRevision: "current-generation",
            agentId: "main",
            label: "Review the change",
            run: "idle",
            observerDigest: {
              health: "done",
              headline: "Ready for review",
              assessment: "The change is complete and awaits review.",
              revision: 3,
            },
            pullRequests: [
              {
                number: 27,
                state: "merged",
                title: "Change",
                url: "https://github.com/synthetic/project/pull/27",
              },
            ],
            archived: false,
            lastActivityAt: 1,
          },
          { key: queuedKey, run: "active" },
        ],
      });
      const listener = vi.fn();
      const unsubscribe = runtime.gateway.subscribeSessionChanges(listener);
      try {
        fixture.load.mockResolvedValueOnce({ pullRequests: [], rateLimited: false });
        await fixture.subscriptions.pollNow();
        expect((await read(fixture, [sessionKey])).sessions[0]?.pullRequests).toEqual([]);
        expect(listener).toHaveBeenCalledWith({ agentId: "main", sessionKey });
        listener.mockClear();
        sessionChanges.emit({ all: true, scope: "catalog" });
        expect(listener).toHaveBeenCalledWith({ agentId: "main", sessionKey });
        expect(listener).toHaveBeenCalledWith({ agentId: "main", sessionKey: queuedKey });
      } finally {
        unsubscribe();
      }
    }));

  it("bounds batches and distinguishes unavailable PRs from known-empty state", () =>
    withFixture(async (fixture) => {
      await expect(
        read(
          fixture,
          Array.from({ length: 41 }, () => sessionKey),
        ),
      ).rejects.toThrow("at most 40");
      await expect(read(fixture, [" "])).rejects.toThrow("nonempty");
      fixture.load.mockRejectedValueOnce(new Error("Synthetic PR outage"));
      expect(await read(fixture, [sessionKey])).toMatchObject({
        sessions: [{ key: sessionKey, pullRequests: [], pullRequestsUnavailable: true }],
        warnings: ["Pull-request state is unavailable for some sessions."],
      });
      await fixture.subscriptions.pollNow();
      expect((await read(fixture, [sessionKey])).sessions[0]?.pullRequestsUnavailable).toBe(true);
      await fixture.subscriptions.pollNow();
      expect((await read(fixture, [sessionKey])).warnings).toBeUndefined();
      expect(fixture.load).toHaveBeenCalledTimes(2);
    }));

  it("uses live run liveness instead of a persisted running status", () =>
    withFixture(async (fixture) => {
      const staleKey = "agent:main:stale-running";
      const activeKey = "agent:main:live-running";
      const queuedKey = "agent:main:queued-input";
      await fixture.seed(staleKey, fixture.profile.id, { status: "running" });
      await fixture.seed(activeKey, fixture.profile.id, {
        status: "failed",
        lastRunError: "Old failure",
      });
      await fixture.seed(queuedKey, fixture.profile.id, { status: "queued" });
      registerAgentRunContext("facts-live-run", {
        agentId: "main",
        sessionKey: activeKey,
        projectSessionActive: true,
      });
      try {
        expect((await read(fixture, [staleKey, activeKey, queuedKey])).sessions).toMatchObject([
          { key: staleKey, run: "idle" },
          { key: activeKey, run: "active" },
          { key: queuedKey, run: "active" },
        ]);
      } finally {
        clearAgentRunContext("facts-live-run");
      }
      expect((await read(fixture, [activeKey])).sessions[0]?.run).toBe("failed");
    }));

  it.each([false, true])(
    "bounds fresh PR loads and reuses the owner cache (initial rate limit: %s)",
    (rateLimited) =>
      withFixture(async (fixture) => {
        const keys = Array.from({ length: 10 }, (_, index) => `agent:main:pr-facts-${index}`);
        const plainKey = "agent:main:no-pr-target";
        await fixture.seed(plainKey);
        for (const key of keys) {
          await fixture.seed(key, fixture.profile.id, {
            worktree: { id: key, branch: "change", repoRoot: "/synthetic/repository" },
          });
        }
        fixture.load.mockResolvedValue({ pullRequests: [], rateLimited });
        const first = await read(fixture, [plainKey, ...keys]);
        expect(first.sessions[0]).toMatchObject({ key: plainKey, pullRequests: [] });
        expect(first.sessions[0]?.pullRequestsUnavailable).toBeUndefined();
        expect(first.sessions.slice(1).every((facts) => facts.pullRequestsUnavailable)).toBe(true);
        await fixture.subscriptions.pollNow();
        expect(fixture.load).toHaveBeenCalledTimes(8);
        fixture.load.mockResolvedValue({ pullRequests: [], rateLimited: false });
        const next = await read(fixture, keys);
        expect(
          next.sessions
            .slice(0, 8)
            .every((facts) => Boolean(facts.pullRequestsUnavailable) === rateLimited),
        ).toBe(true);
        expect(next.sessions.slice(8).every((facts) => facts.pullRequestsUnavailable)).toBe(true);
        await fixture.subscriptions.pollNow();
        expect(fixture.load).toHaveBeenCalledTimes(rateLimited ? 16 : 10);
        const loaded = await read(fixture, keys);
        expect(loaded.sessions.slice(8).every((facts) => !facts.pullRequestsUnavailable)).toBe(
          true,
        );
        await fixture.subscriptions.pollNow();
        expect((await read(fixture, keys)).warnings).toBeUndefined();
        await fixture.subscriptions.pollNow();
        expect(fixture.load).toHaveBeenCalledTimes(rateLimited ? 18 : 10);
      }),
  );

  it("retries rate-limited snapshots and bounds and redacts PR titles", () =>
    withFixture(async (fixture) => {
      const pullRequest = {
        number: 42,
        owner: "synthetic",
        repo: "project",
        branch: "change",
        state: "open" as const,
        url: "https://github.com/synthetic/project/pull/42",
        title: `Authorization: Bearer synthetic-secret-value ${"x".repeat(160)}`,
      };
      fixture.load.mockResolvedValueOnce({
        pullRequests: [pullRequest, { ...pullRequest, number: 43, title: "", url: "" }],
        rateLimited: true,
      });
      await read(fixture, [sessionKey]);
      await fixture.subscriptions.pollNow();
      const limited = (await read(fixture, [sessionKey])).sessions[0]!;
      expect(limited).toMatchObject({
        pullRequestsUnavailable: true,
        pullRequestsRateLimited: true,
      });
      expect(limited.pullRequests[0]).toMatchObject({
        number: 42,
        state: "open",
        url: pullRequest.url,
      });
      expect(limited.pullRequests[0]?.title?.length).toBeLessThanOrEqual(120);
      expect(limited.pullRequests[0]?.title).not.toContain("synthetic-secret-value");
      expect(limited.pullRequests[1]).toEqual({ number: 43, state: "open" });
      await fixture.subscriptions.pollNow();
      const recovered = (await read(fixture, [sessionKey])).sessions[0]!;
      expect(recovered.pullRequestsUnavailable).toBeUndefined();
      expect(recovered.pullRequestsRateLimited).toBeUndefined();
      expect(fixture.load).toHaveBeenCalledTimes(2);
    }));

  it("projects Markdown previews to bounded plain text before exposing session facts", () =>
    withFixture(async (fixture) => {
      const releaseForeground = retainSessionListForegroundWork();
      try {
        const projection = getSessionRowProjection(fixture.context)!;
        await projection.ensureMaterialized();
        const row = projection.describe({ key: sessionKey, agentId: "main" })!;
        for (const [preview, expected] of [
          [
            "Merged [#42](https://github.com/synthetic/project/pull/42) into `main`.\n\n**Cleanup finished.**\n1. Checked <b>links</b>.\n2. Ran   tests.\n<script>hidden()</script>",
            "Merged #42 into main. Cleanup finished. 1. Checked links. 2. Ran tests.",
          ],
          [
            `[Ready](https://example.test/${"a".repeat(450)}) **${"x".repeat(450)}**`,
            `Ready ${"x".repeat(394)}`,
          ],
        ]) {
          publishTranscriptFields(
            row,
            { lastMessagePreview: preview },
            projection.state.cfg,
            projection.state.rowContext,
          );
          const facts = (await read(fixture, [sessionKey])).sessions[0]!;
          expect(facts.lastMessagePreview).toBe(expected);
          expect(facts.lastMessagePreview!.length).toBeLessThanOrEqual(400);
        }
      } finally {
        releaseForeground();
      }
    }));

  it("prepares pending membership under the service's bound Gateway without a connected client", () =>
    withFixture(async (fixture) => {
      const releaseForeground = retainSessionListForegroundWork();
      try {
        // Another operator's draft is creator-private; the service read has no sharing
        // filter, so the reader itself must keep it away from preview enrichment.
        const foreignDraft = "agent:main:foreign-draft";
        await fixture.seed(foreignDraft, fixture.other.id, { visibility: "draft" });
        await persistSessionTranscriptTurn(
          { agentId: "main", sessionKey, sessionId: fixture.sessionId },
          {
            messages: [{ message: { role: "assistant", content: "May I merge this change?" } }],
            touchSessionEntry: false,
            updateMode: "none",
          },
        );
        const projection = getSessionRowProjection(fixture.context)!;
        await projection.ensureMaterialized();
        sessionChanges.emit({ agentId: "main", sessionKey, factsInvalidated: "category" });
        expect(projection.needsMembershipPreparation()).toBe(true);
        expect(projection.sharingTargetState({ key: sessionKey, agentId: "main" }).status).toBe(
          "pending",
        );
        const result = await withPluginRuntimeGatewayRequestScope(
          {
            context: fixture.context,
            isWebchatConnect: () => false,
            pluginId: "workboard",
            pluginOrigin: "bundled",
          },
          () => runtime.gateway.readSessionFacts({ sessionKeys: [sessionKey, foreignDraft] }),
        );
        expect(result.sessions).toMatchObject([
          {
            key: sessionKey,
            sessionId: fixture.sessionId,
          },
        ]);
        expect(result.sessions.map((session) => session.key)).not.toContain(foreignDraft);
        // Optional transcript enrichment must not bypass foreground ownership.
        expect(result.sessions[0]?.lastMessagePreview).toBeUndefined();
      } finally {
        releaseForeground();
      }
    }));

  it.for(["current", "session", "owner"] as const)(
    "publishes background PR facts only while its lifetime remains current: %s",
    (lifetime, { signal }) =>
      withFixture(async (fixture) => {
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const published = createDeferredCore();
        const listener = vi.fn();
        const subscribe = () =>
          runtime.gateway.subscribeSessionChanges((change) => {
            if (change.sessionKey === sessionKey) {
              listener();
              published.resolve();
            }
          });
        let unsubscribe = lifetime === "current" ? undefined : subscribe();
        fixture.load.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return { pullRequests: [], rateLimited: false };
        });
        try {
          const result = await withinTest(read(fixture, [sessionKey]), signal);
          if (lifetime === "current") {
            expect(result.sessions).toMatchObject([
              { key: sessionKey, pullRequestsUnavailable: true },
            ]);
          }
          await withinTest(entered.promise, signal);
          if (lifetime === "current") {
            expect((await read(fixture, [sessionKey])).sessions[0]?.pullRequestsUnavailable).toBe(
              true,
            );
            expect(fixture.load).toHaveBeenCalledTimes(1);
            const projection = getSessionRowProjection(fixture.context)!;
            const query = { key: sessionKey, agentId: "main" };
            const before = projection.capture(query)!;
            const revision = before.databaseFactsRevision;
            const retainedFacts = before.retainedDatabaseFacts;
            expect(retainedFacts).toBeDefined();
            unsubscribe = subscribe();
            release.resolve();
            await withinTest(published.promise, signal);
            const ready = await read(fixture, [sessionKey]);
            expect(projection.capture(query)?.databaseFactsRevision).toBe(revision);
            expect(projection.capture(query)?.retainedDatabaseFacts).toBe(retainedFacts);
            expect(ready.sessions[0]?.pullRequestsUnavailable).toBeUndefined();
            expect(ready.warnings).toBeUndefined();
            expect(fixture.load).toHaveBeenCalledTimes(1);
            fixture.access.abort(new Error("Synthetic caller grant retired"));
            await expect(read(fixture, [sessionKey])).rejects.toThrow();
          } else {
            if (lifetime === "session") {
              await fixture.seed(sessionKey, fixture.other.id, { visibility: "draft" });
            }
            listener.mockClear();
            const stopping = lifetime === "owner" ? fixture.subscriptions.stop() : undefined;
            release.resolve();
            await (stopping ?? fixture.subscriptions.pollNow());
            expect(listener).not.toHaveBeenCalled();
          }
        } finally {
          release.resolve();
          unsubscribe?.();
        }
      }),
  );
});
