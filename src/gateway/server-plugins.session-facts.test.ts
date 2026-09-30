import { afterAll, describe, expect, it } from "vitest";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.transcript-turn.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createFixture, sessionKey } from "./control-ui-session-pr-access.test-support.js";
import { createRequestGatewayMethodRegistry } from "./server-methods.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";

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
  it("projects admitted session identity, trajectory and canonical PR states", () =>
    withFixture(async (fixture) => {
      const privateKey = "agent:main:private-change";
      const queuedKey = "agent:main:queued-change";
      await fixture.seed(privateKey, fixture.other.id, { visibility: "draft" });
      await fixture.seed(queuedKey, fixture.profile.id, { status: "queued" });
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
            pullRequests: [{ number: 27, state: "merged" }],
            archived: false,
            lastActivityAt: 1,
          },
          { key: queuedKey, run: "active" },
        ],
      });
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
    }));

  it("reads under the service's bound Gateway without a connected client", () =>
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
        const result = await withPluginRuntimeGatewayRequestScope(
          {
            context: fixture.context,
            isWebchatConnect: () => false,
            pluginId: "workboard",
            pluginOrigin: "bundled",
          },
          () => runtime.gateway.readSessionFacts({ sessionKeys: [foreignDraft, sessionKey] }),
        );
        expect(result.sessions).toMatchObject([
          {
            key: sessionKey,
            sessionId: fixture.sessionId,
            lastMessagePreview: "May I merge this change?",
          },
        ]);
        expect(result.sessions.map((session) => session.key)).not.toContain(foreignDraft);
        expect(result.warnings).toBeUndefined();
      } finally {
        releaseForeground();
      }
    }));

  it("keeps an earlier session and its latest reply when activity changes during a later PR read", () =>
    withFixture(async (fixture) => {
      const laterKey = "agent:main:later-change";
      await fixture.seed(laterKey, fixture.profile.id);
      const transcriptTarget = { agentId: "main", sessionKey, sessionId: fixture.sessionId };
      await persistSessionTranscriptTurn(transcriptTarget, {
        messages: [{ message: { role: "assistant", content: "Implementation is complete." } }],
        touchSessionEntry: false,
        updateMode: "none",
      });
      const entered = createDeferredCore();
      const release = createDeferredCore();
      fixture.load.mockImplementation(async ({ sessionKey: key }) => {
        if (key === laterKey) {
          entered.resolve();
          await release.promise;
        }
        return { pullRequests: [], rateLimited: false };
      });
      const reading = read(fixture, [sessionKey, laterKey]);
      try {
        await Promise.race([
          entered.promise,
          reading.then(() => {
            throw new Error("Later PR read was not reached");
          }),
        ]);
        await fixture.seed(sessionKey, fixture.profile.id, {
          label: "Work resumed",
          lifecycleRevision: "current-generation",
          status: "running",
          lastActivityAt: 2,
        });
        await persistSessionTranscriptTurn(transcriptTarget, {
          messages: [{ message: { role: "assistant", content: "May I merge this change?" } }],
          touchSessionEntry: false,
          updateMode: "none",
        });
        await getSessionRowProjection(fixture.context)?.ensureMaterialized();
        release.resolve();
        const result = await reading;
        expect(result.sessions).toMatchObject([
          {
            key: sessionKey,
            sessionId: fixture.sessionId,
            label: "Work resumed",
            run: "active",
            lastActivityAt: 2,
            lastMessagePreview: "May I merge this change?",
          },
          { key: laterKey },
        ]);
      } finally {
        release.resolve();
        await reading.catch(() => undefined);
      }
    }));

  it("rejects disclosure when the caller's grant expires during the PR read", () =>
    withFixture(async (fixture) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      fixture.load.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { pullRequests: [], rateLimited: false };
      });
      const reading = read(fixture, [sessionKey]);
      try {
        await Promise.race([
          entered.promise,
          reading.then(() => {
            throw new Error("PR read was not reached");
          }),
        ]);
        fixture.access.abort(new Error("Synthetic caller grant retired"));
        release.resolve();
        await expect(reading).rejects.toThrow();
      } finally {
        release.resolve();
        await reading.catch(() => undefined);
      }
    }));
});
