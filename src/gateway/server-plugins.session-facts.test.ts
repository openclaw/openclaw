import { afterAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.transcript-turn.js";
import { registerAgentRunCapacityWait } from "../infra/agent-run-capacity-wait.js";
import {
  clearAgentRunContext,
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
} from "../infra/agent-run-registry.js";
import { applyLoggingConfig, resetLogger } from "../logging/logger.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import {
  withPluginRuntimeGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import type {
  RuntimeSessionFactsSelection,
  RuntimeSessionFactsSelectionResult,
} from "../plugins/runtime/types-session-facts.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { emitUserProfilesChanged } from "../state/user-profile-events.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createFixture, sessionKey } from "./control-ui-session-pr-access.test-support.js";
import { bumpGatewayAccessRevision } from "./gateway-access-revision.js";
import { createRequestGatewayMethodRegistry } from "./server-methods.js";
import {
  captureRpcTargetForTest,
  registerRpcSourceForTest,
} from "./server-methods/rpc-source-fixtures.test-support.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { publishTranscriptFields } from "./session-row-projection-record.js";
import * as transcriptBackfill from "./session-row-transcript-backfill.js";
import { claimRpcSourceForTest } from "./test-helpers.rpc-source.js";

type Fixture = Awaited<ReturnType<typeof createFixture>>;
let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
const runtime = createPluginRuntime();
const observerDigest = {
  health: "done" as const,
  headline: "Ready for review",
  assessment: "The change is complete and awaits review.",
  revision: 3,
};

afterAll(async () => {
  await state?.cleanup();
});

async function withFixture(
  run: (fixture: Fixture, facts: ReturnType<typeof bindFacts>) => Promise<void>,
) {
  state ??= await createOpenClawTestState({ scenario: "minimal" });
  state.applyEnv();
  const work = new AsyncWorkScope();
  let fixture: Fixture | undefined;
  try {
    await work.track(async () => {
      fixture = await createFixture("operator.read", false, {
        worktree: worktree("facts-worktree"),
        label: "Review the change",
        lifecycleRevision: "current-generation",
        status: "done",
        lastActivityAt: 1,
        observerDigest: { ...observerDigest, sessionKey, updatedAt: 10 },
      });
      const methodRegistry = createRequestGatewayMethodRegistry();
      fixture.context.getGatewayMethodRegistry = () => methodRegistry;
      try {
        await run(fixture, bindFacts(fixture));
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

function bindFacts(fixture: Fixture) {
  function inScope<T>(run: () => T, client: Fixture["client"] | undefined) {
    return withPluginRuntimeGatewayRequestScope(
      {
        context: fixture.context,
        client,
        isWebchatConnect: () => false,
        pluginId: "workboard",
        pluginOrigin: "bundled",
      },
      run,
    );
  }
  function consume<T>(
    run: (snapshot: RuntimeSessionFactsSelectionResult) => Promise<T>,
    client = fixture.client,
    selection: RuntimeSessionFactsSelection = { archived: false, sortBy: "activity" },
  ) {
    return inScope(() => runtime.gateway.withSessionFacts(selection, run), client);
  }
  return {
    inScope,
    consume,
    read: (sessionKeys: readonly string[] = [sessionKey], service = false) => {
      return inScope(
        () => runtime.gateway.readSessionFacts({ sessionKeys }),
        service ? undefined : fixture.client,
      );
    },
    selected: (selection: RuntimeSessionFactsSelection = {}, client = fixture.client) => {
      return consume(async (snapshot) => snapshot, client, {
        archived: false,
        sortBy: "activity",
        ...selection,
      });
    },
    getProjection: () => getSessionRowProjection(fixture.context)!,
    commitPreview: async (content: string) => {
      await persistSessionTranscriptTurn(
        { agentId: "main", sessionKey, sessionId: fixture.sessionId },
        {
          config: fixture.cfg,
          messages: [{ message: { role: "assistant", content } }],
          touchSessionEntry: false,
          updateMode: "none",
        },
      );
    },
  };
}
const worktree = (id: string, branch = "change") => ({
  id,
  branch,
  repoRoot: "/synthetic/repository",
});
type PullRequest = Awaited<ReturnType<Fixture["load"]>>["pullRequests"][number];
function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 12,
    owner: "synthetic",
    repo: "project",
    branch: "change",
    state: "open",
    title: "",
    url: "",
    ...overrides,
  };
}

function holdForeground() {
  return { [Symbol.dispose]: retainSessionListForegroundWork() };
}

function fact(snapshot: RuntimeSessionFactsSelectionResult, key = sessionKey) {
  return snapshot.sessions.find((row) => row.key === key);
}

describe("trusted plugin selected session facts", () => {
  it.each(["config-presentation", "secret registry"] as const)(
    "preserves exact and selected text and PR state after %s changes",
    (change) =>
      withFixture(async (fixture, { read, selected }) => {
        using _ = holdForeground();
        const plainKey = "agent:main:redaction-policy";
        const marker = "LANE517MASK";
        const prTitle = "Long synthetic PR title ".repeat(6);

        applyLoggingConfig(undefined);
        try {
          await fixture.seed(plainKey, fixture.profile.id, { label: marker });
          fixture.load.mockResolvedValue({
            pullRequests: [pullRequest({ title: prTitle })],
            rateLimited: false,
          });
          await fixture.subscriptions.replace(fixture.client.connId, [sessionKey]);
          await read([plainKey]);
          await selected();
          fixture.load.mockRejectedValue(new Error("Synthetic PR outage"));
          sessionChanges.emit({ agentId: "main", sessionKey });
          await selected();
          await fixture.subscriptions.pollNow();
          const stale = await selected();

          if (change === "config-presentation") {
            const cfg = { ...fixture.cfg, logging: { redactPatterns: [marker, prTitle] } };
            applyLoggingConfig(cfg.logging);
            setRuntimeConfigSnapshot(cfg);
          } else {
            registerSecretValueForRedaction(marker);
            registerSecretValueForRedaction(prTitle);
          }
          const exact = await read([plainKey]);
          const current = await selected();
          expect(exact.sessions[0]?.label).toBe(marker);
          expect(fact(current, plainKey)?.label).toBe(marker);
          expect(current.retryAt).toBe(stale.retryAt);
          const currentPrs = fact(current)!;
          expect(currentPrs).toMatchObject({
            pullRequestsUnavailable: true,
            pullRequestsStale: true,
          });
          expect(currentPrs.pullRequests).toEqual([
            { number: 12, state: "open", title: prTitle.slice(0, 120) },
          ]);
        } finally {
          resetLogger();
          resetSecretRedactionRegistryForTest();
        }
      }),
  );

  it("retains unchanged facts while persistent rows and authority epochs change", () =>
    withFixture(async (fixture, { selected, getProjection }) => {
      using _ = holdForeground();
      const sibling = "agent:main:unchanged-facts";
      await fixture.seed(sibling, fixture.profile.id, { label: "Unchanged", status: "done" });
      await fixture.subscriptions.replace(fixture.client.connId, [sessionKey]);

      const first = await selected();
      expect(first.scope).toEqual(expect.any(String));
      const unchanged = fact(first, sibling)!;
      expect(Object.isFrozen(unchanged)).toBe(true);
      expect(fact(await selected(), sibling)).toBe(unchanged);
      const peer = await selected({}, fixture.addReader("other-reader").client);
      expect(peer.scope).toBe(first.scope);
      expect(fact(peer, sibling)).toBe(unchanged);
      const projection = getProjection();
      using acquisition = vi.spyOn(projection, "withPreparedExactRows");
      const stable = await selected();
      expect(stable).toBe(peer);
      expect(acquisition).not.toHaveBeenCalled();

      await fixture.seed(sessionKey, fixture.profile.id, {
        label: "Changed title",
        status: "failed",
      });
      const changed = await selected();
      expect(changed.scope).toBe(first.scope);
      expect(changed.revision).not.toBe(first.revision);
      expect(fact(changed)).toMatchObject({ label: "Changed title", run: "failed" });
      expect(fact(changed, sibling)).toBe(unchanged);
      expect(
        acquisition.mock.calls
          .flatMap(([queries]) => queries(fixture.cfg))
          .some((query) => query.key === sibling),
      ).toBe(false);
      expect(fact(first)?.label).toBe("Review the change");

      let current = changed.scope;
      for (const publish of [
        () => emitUserProfilesChanged(),
        () => bumpGatewayAccessRevision(),
        () =>
          setRuntimeConfigSnapshot({
            ...fixture.cfg,
            messages: { ...fixture.cfg.messages, responsePrefix: "Updated" },
          }),
      ]) {
        publish();
        const next = await selected();
        expect(next.scope).toEqual(expect.any(String));
        expect(next.scope).not.toBe(current);
        current = next.scope;
      }
      await fixture.seed(sibling, fixture.profile.id, {
        label: "Archived",
        archivedAt: Date.now(),
      });
      expect((await selected()).sessions.some((row) => row.key === sibling)).toBe(false);
      const archived = await selected({ archived: "all" });
      expect(fact(archived, sibling)).toMatchObject({ label: "Archived", archived: true });
      const synthetic = {
        ...fixture.client,
        internal: { ...fixture.client.internal, syntheticClient: true as const },
      };
      expect((await selected({}, synthetic)).scope).toBeUndefined();
    }));

  it("retires a transient run first observed after facts preparation yields", ({ signal }) =>
    withFixture(async (fixture, { selected, getProjection }) => {
      using _ = holdForeground();
      const entered = createDeferredCore();
      const release = createDeferredCore();

      let registration: ReturnType<typeof registerRpcSourceForTest> | undefined;
      let releaseClaim: (() => void) | undefined;
      let reading: Promise<RuntimeSessionFactsSelectionResult> | undefined;
      let unsubscribe: (() => void) | undefined;
      try {
        await fixture.subscriptions.replace(fixture.client.connId, [sessionKey]);
        expect((await selected()).sessions[0]?.run).toBe("idle");
        const projection = getProjection();
        const prepare = projection.withPreparedExactRows.bind(projection);
        using preparation = vi.spyOn(projection, "withPreparedExactRows");
        preparation.mockImplementationOnce(async (queries, consume, options) => {
          entered.resolve();
          await release.promise;
          return prepare(queries, consume, options);
        });
        sessionChanges.emit({ agentId: "main", sessionKey, scope: "runtime" });
        reading = selected();
        await withinTest(
          awaitGateBeforeSettlement(
            entered.promise,
            reading,
            "Selection completed before facts preparation yielded",
          ),
          signal,
        );
        const publications = vi.fn();
        unsubscribe = sessionChanges.subscribe(publications);
        const target = captureRpcTargetForTest({
          sessionKey,
          sessionId: fixture.sessionId,
          agentId: "main",
        });
        registration = withPluginRuntimeGatewayContextResolver(
          fixture.context.resolveGatewayContext,
          () =>
            registerRpcSourceForTest({
              storeScope: target.storeScope,
              runId: "selected-run-during-preparation",
              sessionId: fixture.sessionId,
              sessionKey,
              agentId: "main",
              kind: "agent",
            }),
        );
        const source = registration.entry;
        releaseClaim = await withPluginRuntimeGatewayContextResolver(
          fixture.context.resolveGatewayContext,
          () => claimRpcSourceForTest(source),
        );
        release.resolve();
        const active = await withinTest(reading, signal);
        expect(active.sessions[0]?.run).toBe("active");
        expect((await selected()).sessions[0]?.run).toBe("active");
        releaseClaim();
        releaseClaim = undefined;
        registration.cleanup();
        registration = undefined;
        expect(publications).not.toHaveBeenCalled();
        const idle = await selected();
        expect(idle.sessions[0]?.run).toBe("idle");
        expect(idle.revision).not.toBe(active.revision);
        expect(await selected()).toBe(idle);
      } finally {
        release.resolve();
        await reading?.catch(() => {});
        unsubscribe?.();
        releaseClaim?.();
        registration?.cleanup();
      }
    }));

  it("refreshes a cached selection from committed previews while background reads are held", () =>
    withFixture(async (fixture, { selected, getProjection, commitPreview }) => {
      using _ = holdForeground();
      const projection = getProjection();
      await projection.ensureMaterialized();
      const before = await selected();
      expect(before.sessions[0]?.lastMessagePreview).toBeUndefined();
      using backfill = vi.spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields");
      await commitPreview("Prepared committed preview");
      const after = await selected();
      expect(after.sessions[0]?.lastMessagePreview).toBe("Prepared committed preview");
      expect(after.revision).not.toBe(before.revision);
      expect(before.sessions[0]?.lastMessagePreview).toBeUndefined();
      expect(backfill).not.toHaveBeenCalled();
    }));

  it.each(["grant", "role", "profile", "same-object config"] as const)(
    "rejects a selected disclosure when %s authority changes during the callback",
    (change) =>
      withFixture(async (fixture, { consume }) => {
        await consume(async () => "prepared snapshot");
        await expect(
          consume(async (snapshot) => {
            expect(snapshot.scope).toEqual(expect.any(String));
            if (change === "same-object config") {
              fixture.cfg.gateway!.roles!.definitions.reader!.scopes = [];
              setRuntimeConfigSnapshot(fixture.cfg);
            } else {
              await fixture.changeReader(change);
            }
            return "private cached snapshot";
          }),
        ).rejects.toThrow();
      }),
  );

  it("distinguishes failed facts acquisition from an omitted current identity", () =>
    withFixture(async (fixture, { selected, getProjection }) => {
      await selected();
      const projection = getProjection();
      using acquisition = vi.spyOn(projection, "withPreparedExactRows");
      using describeRow = vi.spyOn(projection, "describe");
      sessionChanges.emit({ agentId: "main", sessionKey, scope: "runtime" });
      acquisition.mockRejectedValueOnce(
        new Error("Synthetic facts read failed: API_TOKEN = computeToken()"),
      );
      const failed = await selected();
      expect(failed.sessions).toMatchObject([
        {
          key: sessionKey,
          sessionId: fixture.sessionId,
          unavailable: "Error: Synthetic facts read failed: API_TOKEN = computeToken()",
        },
      ]);
      expect(failed.missingSessionKeys).toBeUndefined();
      describeRow.mockReturnValueOnce(undefined);
      const missing = await selected();
      expect(missing.sessions).toEqual([]);
      expect(missing.missingSessionKeys).toEqual([sessionKey]);
      expect(missing.revision).not.toBe(failed.revision);
      const recovered = await selected();
      expect(recovered.sessions).toMatchObject([{ key: sessionKey, sessionId: fixture.sessionId }]);
      expect(recovered.missingSessionKeys).toBeUndefined();
      expect(recovered.sessions[0]?.unavailable).toBeUndefined();
    }));

  it("expires cached people at the inclusive activity boundary", () =>
    withFixture(async (fixture, { selected }) => {
      const initial = Date.now();
      let now = initial;
      using clock = vi.spyOn(Date, "now");
      clock.mockImplementation(() => now);
      using _ = holdForeground();
      const otherKey = "agent:main:activity-person";
      await fixture.seed(sessionKey, fixture.profile.id, { lastActivityAt: initial - 60_000 });
      await fixture.seed(otherKey, fixture.other.id, { lastActivityAt: initial });
      const activeSelection = () =>
        selected({ activeMinutes: 1, involvingProfileId: fixture.other.id, includePeople: true });
      const people = (value: RuntimeSessionFactsSelectionResult) =>
        value.people?.map((person) => person.identity.id).toSorted();
      const boundary = await activeSelection();
      expect(boundary.sessions.map((row) => row.key)).toEqual([otherKey]);
      expect(people(boundary)).toEqual([fixture.profile.id, fixture.other.id].toSorted());
      expect(boundary.activityExpiresAt).toBe(initial);
      expect(people(await activeSelection())).toEqual(people(boundary));
      now = initial + 1;
      const expired = await activeSelection();
      expect(expired.sessions.map((row) => row.key)).toEqual([otherKey]);
      expect(people(expired)).toEqual([fixture.other.id]);
      expect(expired.activityExpiresAt).toBe(initial + 60_000);
      now = initial + 60_001;
      const empty = await activeSelection();
      expect(empty).toMatchObject({ sessions: [], people: [] });
    }));

  it("backs off unavailable selected PR facts and retains confirmed state only within its lifecycle", () =>
    withFixture(async (fixture, { selected }) => {
      let now = Date.now();
      using clock = vi.spyOn(Date, "now");
      clock.mockImplementation(() => now);
      using _ = holdForeground();
      fixture.load.mockResolvedValue({ pullRequests: [pullRequest()], rateLimited: false });

      await selected();
      await fixture.subscriptions.pollNow();
      const ready = await selected();
      expect(fact(ready)?.pullRequests).toEqual([{ number: 12, state: "open" }]);
      fixture.load.mockRejectedValue(new Error("Synthetic PR outage"));
      sessionChanges.emit({ agentId: "main", sessionKey });
      const unavailable = await selected();
      await fixture.subscriptions.pollNow();
      expect(fact(unavailable)).toMatchObject({
        pullRequestsStale: true,
        pullRequestsUnavailable: true,
        pullRequests: [{ number: 12, state: "open" }],
      });
      expect(unavailable.retryAt).toBe(now + 60_000);
      const attempts = fixture.load.mock.calls.length;
      await selected();
      await fixture.subscriptions.pollNow();
      expect(fixture.load).toHaveBeenCalledTimes(attempts);
      now += 60_000;
      const retried = await selected();
      await fixture.subscriptions.pollNow();
      expect(fixture.load).toHaveBeenCalledTimes(attempts + 1);
      expect(retried.retryAt).toBe(now + 120_000);
      await fixture.seed(sessionKey, fixture.profile.id, { label: "Changed stored metadata" });
      await selected();
      await fixture.subscriptions.pollNow();
      expect(fixture.load).toHaveBeenCalledTimes(attempts + 2);
      await fixture.seed(sessionKey, fixture.profile.id, {
        lifecycleRevision: "replacement-generation",
        worktree: worktree("replacement-worktree"),
      });
      const replaced = fact(await selected())!;
      expect(replaced.pullRequestsStale).toBeUndefined();
      expect(replaced.pullRequests).toEqual([]);
    }));
});

describe("trusted plugin session facts", () => {
  it("subscribes to narrow keyed invalidations until unsubscribed", () => {
    const listener = vi.fn();
    const unsubscribe = runtime.gateway.subscribeSessionChanges(listener);
    using _ = { [Symbol.dispose]: unsubscribe };
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
  });

  it("lists shared sessions as a trusted service while retaining a scoped client's visibility", () =>
    withFixture(async (fixture, { inScope }) => {
      const foreignKey = "agent:main:foreign-shared";
      const incognitoKey = "agent:main:dashboard:incognito-service-roster";
      await fixture.seed(foreignKey, fixture.other.id, { visibility: "shared" });
      await fixture.seed(incognitoKey, fixture.profile.id, { incognito: true });
      const cfg = structuredClone(fixture.cfg);
      cfg.gateway!.roles!.definitions.reader!.sessions = { others: "none" };
      setRuntimeConfigSnapshot(cfg);
      const list = (client?: Fixture["client"]) =>
        inScope(
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
          client,
        );
      expect((await list()).sessions.map(({ key }) => key).toSorted()).toEqual(
        [sessionKey, foreignKey].toSorted(),
      );
      expect((await list(fixture.client)).sessions.map(({ key }) => key)).toEqual([sessionKey]);
    }));

  it("projects identity, registry-backed liveness, trajectory and canonical PR states", () =>
    withFixture(async (fixture, { read }) => {
      const privateKey = "agent:main:private-change";
      const queuedKey = "agent:main:queued-change";
      await fixture.seed(privateKey, fixture.other.id, { visibility: "draft" });
      await fixture.seed(queuedKey, fixture.profile.id, {
        worktree: worktree("queued-worktree", "queued"),
        status: "failed",
        lastRunError: "Old failure",
      });
      const runId = "session-facts-queued-run";
      registerAgentRunContext(runId, {
        agentId: "main",
        sessionKey: queuedKey,
        projectSessionActive: true,
      });
      const releaseWait = registerAgentRunCapacityWait(runId, getAgentRunLifecycleGeneration());
      onTestFinished(() => {
        releaseWait?.();
        clearAgentRunContext(runId);
      });
      const pr = {
        number: 27,
        title: "Change",
        state: "merged" as const,
        url: "https://github.com/synthetic/project/pull/27",
      };
      fixture.load.mockImplementation(async ({ sessionKey: key }) => ({
        pullRequests: key === sessionKey ? [pullRequest(pr)] : [],
        rateLimited: false,
      }));
      await fixture.subscriptions.replace(fixture.client.connId, [sessionKey, queuedKey]);
      const result = await read([
        sessionKey,
        sessionKey,
        privateKey,
        queuedKey,
        "agent:main:absent",
      ]);
      expect(result).toMatchObject({
        sessions: [
          {
            key: sessionKey,
            sessionId: fixture.sessionId,
            lifecycleRevision: "current-generation",
            agentId: "main",
            label: "Review the change",
            run: "idle",
            observerDigest,
            pullRequests: [pr],
            archived: false,
            lastActivityAt: 1,
          },
          { key: queuedKey, run: "active", pullRequests: [] },
        ],
      });
      releaseWait?.();
      expect((await read([queuedKey])).sessions[0]?.run).toBe("active");
      clearAgentRunContext(runId);
      expect((await read([queuedKey])).sessions[0]?.run).toBe("failed");
      const listener = vi.fn();
      const unsubscribe = runtime.gateway.subscribeSessionChanges(listener);
      using _ = { [Symbol.dispose]: unsubscribe };
      fixture.load.mockResolvedValue({ pullRequests: [], rateLimited: false });
      await fixture.subscriptions.pollNow();
      expect((await read()).sessions[0]?.pullRequests).toEqual([]);
      expect(listener).toHaveBeenCalledWith({ agentId: "main", sessionKey });
      listener.mockClear();
      sessionChanges.emit({ all: true, scope: "catalog" });
      expect(listener).toHaveBeenCalledWith({ agentId: "main", sessionKey });
      expect(listener).toHaveBeenCalledWith({ agentId: "main", sessionKey: queuedKey });
    }));

  it("bounds batches and distinguishes unavailable PRs from known-empty state", () =>
    withFixture(async (fixture, { read }) => {
      const oversized = Array.from({ length: 41 }, () => sessionKey);
      await expect(read(oversized)).rejects.toThrow("at most 40");
      await expect(read([" "])).rejects.toThrow("nonempty");
      fixture.load.mockRejectedValueOnce(new Error("Synthetic PR outage"));
      expect(await read()).toMatchObject({
        sessions: [{ key: sessionKey, pullRequests: [], pullRequestsUnavailable: true }],
        warnings: ["Pull-request state is unavailable for some sessions."],
      });
      await fixture.subscriptions.pollNow();
      expect((await read()).sessions[0]?.pullRequestsUnavailable).toBe(true);
      await fixture.subscriptions.pollNow();
      expect((await read()).warnings).toBeUndefined();
      expect(fixture.load).toHaveBeenCalledTimes(2);
    }));

  it.each([false, true])(
    "bounds fresh PR loads and reuses the owner cache (initial rate limit: %s)",
    (rateLimited) =>
      withFixture(async (fixture, { read }) => {
        const keys = Array.from({ length: 10 }, (_, index) => `agent:main:pr-facts-${index}`);
        const plainKey = "agent:main:no-pr-target";
        await fixture.seed(plainKey);
        for (const key of keys) {
          await fixture.seed(key, fixture.profile.id, { worktree: worktree(key) });
        }
        const pr = pullRequest({
          number: 42,
          url: "https://github.com/synthetic/project/pull/42",
          title: `Authorization: Bearer synthetic-secret-value ${"x".repeat(160)}`,
        });
        fixture.load.mockResolvedValue({
          pullRequests: [pr, { ...pr, number: 43, title: "", url: "" }],
          rateLimited,
        });
        const first = await read([plainKey, ...keys]);
        expect(first.sessions[0]).toMatchObject({ key: plainKey, pullRequests: [] });
        expect(first.sessions[0]?.pullRequestsUnavailable).toBeUndefined();
        expect(first.sessions.slice(1).every((facts) => facts.pullRequestsUnavailable)).toBe(true);
        await fixture.subscriptions.pollNow();
        expect(fixture.load).toHaveBeenCalledTimes(8);
        fixture.load.mockResolvedValue({ pullRequests: [], rateLimited: false });
        const next = await read(keys);
        const firstPr = next.sessions[0]!.pullRequests[0];
        expect(firstPr).toMatchObject({ number: 42, state: "open", url: pr.url });
        expect(firstPr?.title?.length).toBeLessThanOrEqual(120);
        expect(firstPr?.title).toContain("synthetic-secret-value");
        expect(next.sessions[0]!.pullRequests[1]).toEqual({ number: 43, state: "open" });
        expect(next.sessions[0]?.pullRequestsRateLimited).toBe(rateLimited || undefined);
        expect(
          next.sessions
            .slice(0, 8)
            .every((facts) => Boolean(facts.pullRequestsUnavailable) === rateLimited),
        ).toBe(true);
        expect(next.sessions.slice(8).every((facts) => facts.pullRequestsUnavailable)).toBe(true);
        await fixture.subscriptions.pollNow();
        expect(fixture.load).toHaveBeenCalledTimes(rateLimited ? 16 : 10);
        const loaded = await read(keys);
        expect(loaded.sessions.slice(8).every((facts) => !facts.pullRequestsUnavailable)).toBe(
          true,
        );
        await fixture.subscriptions.pollNow();
        const recovered = await read(keys);
        expect(recovered.warnings).toBeUndefined();
        for (const row of recovered.sessions) {
          expect(row.pullRequestsUnavailable).toBeUndefined();
          expect(row.pullRequestsRateLimited).toBeUndefined();
        }
        await fixture.subscriptions.pollNow();
        expect(fixture.load).toHaveBeenCalledTimes(rateLimited ? 18 : 10);
      }),
  );

  it("projects Markdown previews to bounded plain text before exposing session facts", () =>
    withFixture(async (fixture, { read, getProjection }) => {
      using _ = holdForeground();
      const projection = getProjection();
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
        const { cfg, rowContext } = projection.state;
        publishTranscriptFields(row, { lastMessagePreview: preview }, cfg, rowContext);
        expect((await read()).sessions[0]?.lastMessagePreview).toBe(expected);
      }
    }));

  it("prepares pending membership under the service's bound Gateway without a connected client", () =>
    withFixture(async (fixture, { read, getProjection, commitPreview }) => {
      using _ = holdForeground();
      // Another operator's draft is creator-private; the service read has no sharing
      // filter, so the reader itself must keep it away from preview enrichment.
      const foreignDraft = "agent:main:foreign-draft";
      await fixture.seed(foreignDraft, fixture.other.id, { visibility: "draft" });
      using backfill = vi.spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields");
      await commitPreview("May I merge this change?");
      const projection = getProjection();
      await projection.ensureMaterialized();
      sessionChanges.emit({ agentId: "main", sessionKey, factsInvalidated: "category" });
      expect(projection.needsMembershipPreparation()).toBe(true);
      expect(projection.sharingTargetState({ key: sessionKey, agentId: "main" }).status).toBe(
        "pending",
      );
      const result = await read([sessionKey, foreignDraft], true);
      expect(result.sessions).toMatchObject([{ key: sessionKey, sessionId: fixture.sessionId }]);
      // Committed preview facts remain available while optional transcript reads wait.
      expect(result.sessions[0]?.lastMessagePreview).toBe("May I merge this change?");
      expect(backfill).not.toHaveBeenCalled();
    }));

  it.for(["current", "session", "owner"] as const)(
    "publishes background PR facts only while its lifetime remains current: %s",
    (lifetime, { signal }) =>
      withFixture(async (fixture, { read, getProjection }) => {
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
          const result = await withinTest(read(), signal);
          if (lifetime === "current") {
            expect(result.sessions).toMatchObject([
              { key: sessionKey, pullRequestsUnavailable: true },
            ]);
          }
          await withinTest(entered.promise, signal);
          if (lifetime === "current") {
            expect((await read()).sessions[0]?.pullRequestsUnavailable).toBe(true);
            expect(fixture.load).toHaveBeenCalledTimes(1);
            const projection = getProjection();
            const query = { key: sessionKey, agentId: "main" };
            const before = projection.capture(query)!;
            const revision = before.databaseFactsRevision;
            const retainedFacts = before.retainedDatabaseFacts;
            expect(retainedFacts).toBeDefined();
            unsubscribe = subscribe();
            release.resolve();
            await withinTest(published.promise, signal);
            const ready = await read();
            expect(projection.capture(query)?.databaseFactsRevision).toBe(revision);
            expect(projection.capture(query)?.retainedDatabaseFacts).toBe(retainedFacts);
            expect(ready.sessions[0]?.pullRequestsUnavailable).toBeUndefined();
            expect(ready.warnings).toBeUndefined();
            expect(fixture.load).toHaveBeenCalledTimes(1);
            fixture.access.abort(new Error("Synthetic caller grant retired"));
            await expect(read()).rejects.toThrow();
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
