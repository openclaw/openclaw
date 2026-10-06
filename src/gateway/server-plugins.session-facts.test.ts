import { afterAll, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.transcript-turn.js";
import { registerAgentRunContext, clearAgentRunContext } from "../infra/agent-run-registry.js";
import { applyLoggingConfig, resetLogger } from "../logging/logger.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
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
import { registerChatAbortController } from "./chat-abort.js";
import { createFixture, sessionKey } from "./control-ui-session-pr-access.test-support.js";
import { bumpGatewayAccessRevision } from "./gateway-access-revision.js";
import { createRequestGatewayMethodRegistry } from "./server-methods.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { observeSessionRowBackfill } from "./session-row-backfill.test-support.js";
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

function withSelectedFacts<T>(
  fixture: Fixture,
  run: (snapshot: RuntimeSessionFactsSelectionResult) => Promise<T>,
  client = fixture.client,
  select: RuntimeSessionFactsSelection = { archived: false, sortBy: "activity" },
) {
  return withPluginRuntimeGatewayRequestScope(
    {
      context: fixture.context,
      client,
      isWebchatConnect: () => false,
      pluginId: "workboard",
      pluginOrigin: "bundled",
    },
    () => runtime.gateway.withSessionFacts(select, run),
  );
}

describe("trusted plugin selected session facts", () => {
  it.each(["config-presentation", "secret registry"] as const)(
    "refreshes exact and selected redaction while preserving PR state after %s changes",
    (change) =>
      withFixture(async (fixture) => {
        const releaseForeground = retainSessionListForegroundWork();
        const plainKey = "agent:main:redaction-policy";
        const marker = "LANE517MASK";
        const prTitle = "Long synthetic PR title ".repeat(6);
        const selected = () => withSelectedFacts(fixture, async (value) => value);
        applyLoggingConfig(undefined);
        try {
          await fixture.seed(plainKey, fixture.profile.id, { label: marker });
          fixture.load.mockResolvedValue({
            pullRequests: [
              {
                number: 12,
                owner: "synthetic",
                repo: "project",
                branch: "change",
                state: "open",
                title: prTitle,
                url: "",
              },
            ],
            rateLimited: false,
          });
          await fixture.subscriptions.replace(fixture.client.connId, [sessionKey]);
          expect((await read(fixture, [plainKey])).sessions[0]?.label).toBe(marker);
          const before = await selected();
          expect(before.sessions.find((row) => row.key === plainKey)?.label).toBe(marker);
          expect(before.sessions.find((row) => row.key === sessionKey)?.pullRequests).toEqual([
            { number: 12, state: "open", title: prTitle.slice(0, 120) },
          ]);
          fixture.load.mockRejectedValue(new Error("Synthetic PR outage"));
          sessionChanges.emit({ agentId: "main", sessionKey });
          await selected();
          await fixture.subscriptions.pollNow();
          const stale = await selected();
          expect(stale.sessions.find((row) => row.key === sessionKey)).toMatchObject({
            pullRequestsStale: true,
            pullRequests: [{ number: 12, state: "open", title: prTitle.slice(0, 120) }],
          });

          if (change === "config-presentation") {
            const cfg = { ...fixture.cfg, logging: { redactPatterns: [marker, prTitle] } };
            applyLoggingConfig(cfg.logging);
            setRuntimeConfigSnapshot(cfg);
          } else {
            registerSecretValueForRedaction(marker);
            registerSecretValueForRedaction(prTitle);
          }
          const exact = await read(fixture, [plainKey]);
          const current = await selected();
          expect(exact.sessions[0]?.label).toBe("***");
          expect(current.sessions.find((row) => row.key === plainKey)?.label).toBe("***");
          expect(current.retryAt).toBe(stale.retryAt);
          const currentPrs = current.sessions.find((row) => row.key === sessionKey)!;
          expect(currentPrs.pullRequestsUnavailable).toBe(true);
          expect(currentPrs.pullRequestsStale).toBe(true);
          expect(currentPrs.pullRequests).toEqual([{ number: 12, state: "open" }]);
          expect(current.redactionRevision).not.toBe(stale.redactionRevision);
        } finally {
          resetLogger();
          resetSecretRedactionRegistryForTest();
          releaseForeground();
        }
      }),
  );

  it("shares the snapshot and revision across concurrent cold and changed reads", ({ signal }) =>
    withFixture(async (fixture) => {
      const releaseForeground = retainSessionListForegroundWork();
      const projection = getSessionRowProjection(fixture.context)!;
      const prepare = projection.withPreparedExactRows.bind(projection);
      const selected = () => withSelectedFacts(fixture, async (value) => value);
      let previous: RuntimeSessionFactsSelectionResult | undefined;
      try {
        for (const label of ["Cold concurrent selection", "Changed concurrent selection"]) {
          await fixture.seed(sessionKey, fixture.profile.id, { label });
          await fixture.subscriptions.replace(fixture.client.connId, [sessionKey]);
          await projection.ensureMaterialized();
          const entered = createDeferredCore();
          const release = createDeferredCore();
          let arrivals = 0;
          using _ = vi
            .spyOn(projection, "withPreparedExactRows")
            .mockImplementation(async (queries, consume, options) => {
              if (++arrivals === 2) {
                entered.resolve();
              }
              await release.promise;
              return prepare(queries, consume, options);
            });
          const reading = Promise.all([selected(), selected()]);
          try {
            await withinTest(
              awaitGateBeforeSettlement(
                entered.promise,
                reading,
                "Concurrent selections completed before both reached facts preparation",
              ),
              signal,
            );
            release.resolve();
            const [first, second] = await withinTest(reading, signal);
            expect(first.sessions).toMatchObject([{ key: sessionKey, label }]);
            expect(second).toBe(first);
            expect(second.revision).toBe(first.revision);
            if (previous) {
              expect(first.revision).not.toBe(previous.revision);
            }
            expect(await selected()).toBe(first);
            previous = first;
          } finally {
            release.resolve();
            await reading.catch(() => {});
          }
        }
      } finally {
        releaseForeground();
      }
    }));

  it("retains unchanged facts while persistent rows and authority epochs change", () =>
    withFixture(async (fixture) => {
      const sibling = "agent:main:unchanged-facts";
      const releaseForeground = retainSessionListForegroundWork();
      try {
        await fixture.seed(sibling, fixture.profile.id, { label: "Unchanged", status: "done" });
        await fixture.subscriptions.replace(fixture.client.connId, [sessionKey]);
        const selected = () => withSelectedFacts(fixture, async (value) => value);
        const first = await selected();
        expect(first.scope).toEqual(expect.any(String));
        const unchanged = first.sessions.find((row) => row.key === sibling)!;
        expect(Object.isFrozen(unchanged)).toBe(true);
        expect((await selected()).sessions.find((row) => row.key === sibling)).toBe(unchanged);
        const peer = await withSelectedFacts(
          fixture,
          async (value) => value,
          fixture.addReader("other-reader").client,
        );
        expect(peer.scope).toBe(first.scope);
        expect(peer.sessions.find((row) => row.key === sibling)).toBe(unchanged);
        const projection = getSessionRowProjection(fixture.context)!;
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
        expect(changed.sessions.find((row) => row.key === sessionKey)).toMatchObject({
          label: "Changed title",
          run: "failed",
        });
        expect(changed.sessions.find((row) => row.key === sibling)).toBe(unchanged);
        expect(
          acquisition.mock.calls
            .flatMap(([queries]) => queries(fixture.cfg))
            .some((query) => query.key === sibling),
        ).toBe(false);
        expect(first.sessions.find((row) => row.key === sessionKey)?.label).toBe(
          "Review the change",
        );

        let current = changed.scope;
        for (const publish of [
          () => emitUserProfilesChanged(),
          () => bumpGatewayAccessRevision(),
          () => setRuntimeConfigSnapshot({ ...fixture.cfg }),
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
        const archived = await withSelectedFacts(fixture, async (value) => value, fixture.client, {
          archived: "all",
          sortBy: "activity",
        });
        expect(archived.sessions.find((row) => row.key === sibling)).toMatchObject({
          label: "Archived",
          archived: true,
        });
        const synthetic = {
          ...fixture.client,
          internal: { ...fixture.client.internal, syntheticClient: true as const },
        };
        expect(
          (await withSelectedFacts(fixture, async (value) => value, synthetic)).scope,
        ).toBeUndefined();
      } finally {
        releaseForeground();
      }
    }));

  it("refreshes transient run owners when they appear and disappear without row publications", () =>
    withFixture(async (fixture) => {
      const release = retainSessionListForegroundWork();
      const selected = () => withSelectedFacts(fixture, async (value) => value);
      let registration: ReturnType<typeof registerChatAbortController> | undefined;
      try {
        expect((await selected()).sessions[0]?.run).toBe("idle");
        registration = registerChatAbortController({
          chatAbortControllers: fixture.context.chatAbortControllers,
          runId: "selected-transient-run",
          sessionId: fixture.sessionId,
          sessionKey,
          agentId: "main",
          timeoutMs: 60_000,
          kind: "agent",
        });
        const active = await selected();
        expect(active.sessions[0]?.run).toBe("active");
        registration.cleanup();
        registration = undefined;
        const idle = await selected();
        expect(idle.sessions[0]?.run).toBe("idle");
        expect(idle.revision).not.toBe(active.revision);
        expect(await selected()).toBe(idle);
      } finally {
        registration?.cleanup();
        release();
      }
    }));

  it("retires a transient run first observed after facts preparation yields", ({ signal }) =>
    withFixture(async (fixture) => {
      const releaseForeground = retainSessionListForegroundWork();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const selected = () => withSelectedFacts(fixture, async (value) => value);
      let registration: ReturnType<typeof registerChatAbortController> | undefined;
      let reading: Promise<RuntimeSessionFactsSelectionResult> | undefined;
      let unsubscribe: (() => void) | undefined;
      try {
        await fixture.subscriptions.replace(fixture.client.connId, [sessionKey]);
        expect((await selected()).sessions[0]?.run).toBe("idle");
        const projection = getSessionRowProjection(fixture.context)!;
        const prepare = projection.withPreparedExactRows.bind(projection);
        using _ = vi
          .spyOn(projection, "withPreparedExactRows")
          .mockImplementationOnce(async (queries, consume, options) => {
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
        registration = registerChatAbortController({
          chatAbortControllers: fixture.context.chatAbortControllers,
          runId: "selected-run-during-preparation",
          sessionId: fixture.sessionId,
          sessionKey,
          agentId: "main",
          timeoutMs: 60_000,
          kind: "agent",
        });
        release.resolve();
        const active = await withinTest(reading, signal);
        expect(active.sessions[0]?.run).toBe("active");
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
        registration?.cleanup();
        releaseForeground();
      }
    }));

  it("refreshes a cached selection when background transcript enrichment publishes", () =>
    withFixture(async (fixture) => {
      const release = retainSessionListForegroundWork();
      try {
        await persistSessionTranscriptTurn(
          { agentId: "main", sessionKey, sessionId: fixture.sessionId },
          {
            messages: [{ message: { role: "assistant", content: "Prepared background preview" } }],
            touchSessionEntry: false,
            updateMode: "none",
          },
        );
        const projection = getSessionRowProjection(fixture.context)!;
        await projection.ensureMaterialized();
        const before = await withSelectedFacts(fixture, async (value) => value);
        expect(before.sessions[0]?.lastMessagePreview).toBeUndefined();
        const published = observeSessionRowBackfill([sessionKey], projection);
        release();
        await published;
        const after = await withSelectedFacts(fixture, async (value) => value);
        expect(after.sessions[0]?.lastMessagePreview).toBe("Prepared background preview");
        expect(after.revision).not.toBe(before.revision);
        expect(before.sessions[0]?.lastMessagePreview).toBeUndefined();
      } finally {
        release();
      }
    }));

  it.each(["grant", "role", "profile", "same-object config"] as const)(
    "rejects a selected disclosure when %s authority changes during the callback",
    (change) =>
      withFixture(async (fixture) => {
        await withSelectedFacts(fixture, async () => "prepared snapshot");
        await expect(
          withSelectedFacts(fixture, async (snapshot) => {
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
    withFixture(async (fixture) => {
      const selected = () => withSelectedFacts(fixture, async (value) => value);
      await selected();
      const projection = getSessionRowProjection(fixture.context)!;
      const acquisition = vi.spyOn(projection, "withPreparedExactRows");
      const describeRow = vi.spyOn(projection, "describe");
      try {
        sessionChanges.emit({ agentId: "main", sessionKey, scope: "runtime" });
        acquisition.mockRejectedValueOnce(new Error("Synthetic facts read failed"));
        const failed = await selected();
        expect(failed.sessions).toMatchObject([
          {
            key: sessionKey,
            sessionId: fixture.sessionId,
            unavailable: "Error: Synthetic facts read failed",
          },
        ]);
        expect(failed.missingSessionKeys).toBeUndefined();
        describeRow.mockReturnValueOnce(undefined);
        const missing = await selected();
        expect(missing.sessions).toEqual([]);
        expect(missing.missingSessionKeys).toEqual([sessionKey]);
        expect(missing.revision).not.toBe(failed.revision);
        const recovered = await selected();
        expect(recovered.sessions).toMatchObject([
          { key: sessionKey, sessionId: fixture.sessionId },
        ]);
        expect(recovered.missingSessionKeys).toBeUndefined();
        expect(recovered.sessions[0]?.unavailable).toBeUndefined();
      } finally {
        acquisition.mockRestore();
        describeRow.mockRestore();
      }
    }));

  it("expires cached people at the inclusive activity boundary and reselects after clock rollback", () =>
    withFixture(async (fixture) => {
      const initial = Date.now();
      let now = initial;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const releaseForeground = retainSessionListForegroundWork();
      try {
        const otherKey = "agent:main:activity-person";
        await fixture.seed(sessionKey, fixture.profile.id, { lastActivityAt: initial - 60_000 });
        await fixture.seed(otherKey, fixture.other.id, { lastActivityAt: initial });
        const selected = () =>
          withSelectedFacts(fixture, async (value) => value, fixture.client, {
            archived: false,
            sortBy: "activity",
            activeMinutes: 1,
            involvingProfileId: fixture.other.id,
            includePeople: true,
          });
        const people = (value: RuntimeSessionFactsSelectionResult) =>
          value.people?.map((person) => person.identity.id).toSorted();
        const boundary = await selected();
        expect(boundary.sessions.map((row) => row.key)).toEqual([otherKey]);
        expect(people(boundary)).toEqual([fixture.profile.id, fixture.other.id].toSorted());
        expect(boundary.activityExpiresAt).toBe(initial);
        expect(people(await selected())).toEqual(people(boundary));
        now = initial + 1;
        const expired = await selected();
        expect(expired.sessions.map((row) => row.key)).toEqual([otherKey]);
        expect(people(expired)).toEqual([fixture.other.id]);
        expect(expired.activityExpiresAt).toBe(initial + 60_000);
        now = initial - 1;
        expect(people(await selected())).toEqual(people(boundary));
        now = initial + 60_001;
        const empty = await selected();
        expect(empty.sessions).toEqual([]);
        expect(empty.people).toEqual([]);
      } finally {
        releaseForeground();
        clock.mockRestore();
      }
    }));

  it("backs off unavailable selected PR facts and retains confirmed state only within its lifecycle", () =>
    withFixture(async (fixture) => {
      let now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const releaseForeground = retainSessionListForegroundWork();
      try {
        fixture.load.mockResolvedValue({
          pullRequests: [
            {
              number: 12,
              owner: "synthetic",
              repo: "project",
              branch: "change",
              state: "open",
              title: "",
              url: "",
            },
          ],
          rateLimited: false,
        });
        const selected = () => withSelectedFacts(fixture, async (value) => value);
        await selected();
        await fixture.subscriptions.pollNow();
        const ready = await selected();
        expect(ready.sessions.find((row) => row.key === sessionKey)?.pullRequests).toEqual([
          { number: 12, state: "open" },
        ]);
        fixture.load.mockRejectedValue(new Error("Synthetic PR outage"));
        sessionChanges.emit({ agentId: "main", sessionKey });
        const unavailable = await selected();
        await fixture.subscriptions.pollNow();
        expect(unavailable.sessions.find((row) => row.key === sessionKey)).toMatchObject({
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
        await fixture.seed(sessionKey, fixture.profile.id, {
          lifecycleRevision: "replacement-generation",
          worktree: {
            id: "replacement-worktree",
            branch: "change",
            repoRoot: "/synthetic/repository",
          },
        });
        const replaced = (await selected()).sessions.find((row) => row.key === sessionKey)!;
        expect(replaced.pullRequestsStale).toBeUndefined();
        expect(replaced.pullRequests).toEqual([]);
      } finally {
        releaseForeground();
        clock.mockRestore();
      }
    }));
});

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
