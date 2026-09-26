import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSessionAuthSelection } from "../../agents/auth-profiles/session-override.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveAdmittedRunSessionFile } from "./agent-runner-core.js";
import { prepareReplyRunAdmission } from "./get-reply-run-admission.js";
import type { PreparedReplyRunContext } from "./get-reply-run-context.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { resolveFollowupRunToolAuthorityFingerprint } from "./reply-tool-authority.js";

vi.mock("../../agents/auth-profiles/session-override.js", () => ({
  resolveSessionAuthSelection: vi.fn(async () => undefined),
}));
vi.mock("./session-system-events.js", () => ({
  drainFormattedSystemEvents: async () => undefined,
}));
vi.mock("./get-reply-run-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./get-reply-run-helpers.js")>()),
  loadAgentRunnerRuntime: async () => ({ runReplyAgent: vi.fn() }),
  loadEmbeddedAgentRuntime: async () => ({
    resolveActiveEmbeddedRunSessionId: () => undefined,
    resolveActiveEmbeddedRunSessionIdBySessionFile: () => undefined,
    resolveEmbeddedSessionLane: () => undefined,
  }),
  loadSessionUpdatesRuntime: async () => ({
    ensureSkillSnapshot: async ({ sessionEntry }: { sessionEntry: SessionEntry }) => ({
      sessionEntry,
    }),
  }),
}));

function createAdmissionFixture() {
  const sessionKey = "agent:main:slack:channel:room:thread:100.1";
  const sessionId = "session";
  const entry: SessionEntry = { sessionId, updatedAt: 1 };
  const ctx = { SessionKey: sessionKey, Provider: "slack", ChatType: "channel" };
  const context = {
    params: {
      ctx,
      sessionCtx: ctx,
      cfg: {},
      agentId: "main",
      agentDir: "/tmp/agent",
      directives: {},
      modelState: {
        allowedModelCatalog: [],
        resolveThinkingCatalog: async () => [],
      },
      provider: "anthropic",
      model: "claude",
      typing: { cleanup: vi.fn() },
      sessionKey,
      sessionId,
      storePath: "/tmp/agent/sessions/sessions.json",
      sessionStore: { [sessionKey]: entry },
      resolvedThinkLevel: "off",
    },
    sessionEntry: entry,
    traceRunPhase: <T>(_name: string, run: () => T) => run(),
    baseBodyFinal: "Use the revised request",
    prefixedBodyBase: "Use the revised request",
    hasUserBody: true,
    workspaceDir: "/tmp/workspace",
    skillsWorkspaceDir: "/tmp/workspace",
    useFastReplyRuntime: false,
    thinkingRuntime: "embedded",
    getInboundContext: () => ({ inboundUserContext: "" }),
    getSessionEntry: () => entry,
  } as unknown as PreparedReplyRunContext;
  return { context, entry, sessionKey, sessionId };
}

// Exercise the producer before execution: queued admission later normalizes the
// same transcript to its scoped key, which must not change tool authority.
afterEach(() => vi.clearAllMocks());

describe("prepared reply transcript identity", () => {
  it.each(["steer", "followup"] as const)(
    "keeps %s admission independent of an older queued followup",
    async (mode) => {
      const { context, sessionKey, sessionId } = createAdmissionFixture();
      const older = createQueueTestRun({ prompt: "Earlier followup", messageId: `older-${mode}` });
      const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
      operation.setPhase("running");
      enqueueFollowupRun(sessionKey, older, { mode: "followup" }, "message-id", undefined, false);
      try {
        const prepared = await prepareReplyRunAdmission({ ...context, effectiveQueueMode: mode });
        expect(prepared).toMatchObject({
          kind: "ready",
          isActive: true,
          shouldSteer: mode === "steer",
          shouldFollowup: true,
        });
        expect(getExistingFollowupQueue(sessionKey)?.items).toEqual([older]);
      } finally {
        operation.complete();
        clearFollowupQueue(sessionKey);
      }
    },
  );

  it.each([false, true])(
    "keeps caller-only model auth selection off the shared session (fast=%s)",
    async (fast) => {
      const { context, entry } = createAdmissionFixture();
      entry.authProfileOverride = "fixture:shared";
      entry.authProfileOverrideSource = "user";
      vi.mocked(resolveSessionAuthSelection).mockImplementationOnce(async (params) => {
        expect(params.storePath).toBeUndefined();
        expect(params.sessionEntry).not.toBe(entry);
        if (!params.sessionEntry) {
          throw new Error("Expected an auth selection snapshot");
        }
        params.sessionEntry.authProfileOverride = "fixture:turn";
        return { profileId: "fixture:turn", source: "auto", routeRequirement: undefined };
      });

      const result = await prepareReplyRunAdmission({
        ...context,
        useFastReplyRuntime: fast,
        params: {
          ...context.params,
          provider: "fixture",
          model: "allowed",
          modelState: { ...context.params.modelState, operatorModelOverride: true },
        },
      });
      expect(result).toMatchObject({ kind: "ready", authProfileId: "fixture:turn" });
      expect(resolveSessionAuthSelection).toHaveBeenCalledOnce();
      expect(entry.authProfileOverride).toBe("fixture:shared");
    },
  );

  it("keeps incoming authority identical when the active turn came from the queue", async () => {
    const { context, sessionKey, sessionId } = createAdmissionFixture();
    const prepared = await prepareReplyRunAdmission(context);
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready") {
      throw new Error("Expected a prepared reply");
    }
    const incoming = createQueueTestRun({ prompt: "Use the revised request" });
    incoming.run = {
      ...incoming.run,
      agentId: "main",
      sessionKey,
      sessionId,
      sessionFile: prepared.preparedSessionState.sessionFile,
    };
    const queued = {
      ...incoming,
      run: {
        ...incoming.run,
        sessionFile: resolveAdmittedRunSessionFile({
          sessionKey: incoming.run.sessionKey,
          sessionFile: incoming.run.sessionFile,
        })!,
      },
    };
    expect(resolveFollowupRunToolAuthorityFingerprint(incoming)).toBe(
      resolveFollowupRunToolAuthorityFingerprint(queued),
    );
    expect(prepared.preparedSessionState.sessionFile).toBe(sessionKey);
  });
});
