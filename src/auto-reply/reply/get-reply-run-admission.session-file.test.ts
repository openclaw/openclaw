import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveAdmittedRunSessionFile } from "./agent-runner-core.js";
import { prepareReplyRunAdmission } from "./get-reply-run-admission.js";
import type { PreparedReplyRunContext } from "./get-reply-run-context.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { resolveFollowupRunToolAuthorityFingerprint } from "./reply-tool-authority.js";

vi.mock("../../agents/auth-profiles/session-override.js", () => ({
  resolveSessionAuthSelection: async () => undefined,
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

// Exercise the producer before execution: queued admission later normalizes the
// same transcript to its scoped key, which must not change tool authority.
describe("prepared reply transcript identity", () => {
  it("keeps incoming authority identical when the active turn came from the queue", async () => {
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
        sessionFile: resolveAdmittedRunSessionFile({ ...incoming.run })!,
      },
    };
    expect(resolveFollowupRunToolAuthorityFingerprint(incoming)).toBe(
      resolveFollowupRunToolAuthorityFingerprint(queued),
    );
    expect(prepared.preparedSessionState.sessionFile).toBe(sessionKey);
  });
});
