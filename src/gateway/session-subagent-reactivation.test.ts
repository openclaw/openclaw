/**
 * Subagent session reactivation tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as acpMetadata from "../acp/runtime/session-meta-readonly.js";
import { upsertAcpSessionMeta } from "../acp/runtime/session-meta-write.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const getLatestSubagentRunByChildSessionKeyMock = vi.fn();
const getLatestLiveSubagentRunByChildSessionKeyMock = vi.fn();
const replaceSubagentRunAfterSteerMock = vi.fn();

vi.mock("../agents/subagents/registry/subagent-registry-read.js", async () => {
  const actual = await vi.importActual<
    typeof import("../agents/subagents/registry/subagent-registry-read.js")
  >("../agents/subagents/registry/subagent-registry-read.js");
  return {
    ...actual,
    getLatestSubagentRunByChildSessionKey: (...args: unknown[]) =>
      getLatestSubagentRunByChildSessionKeyMock(...args),
    getLatestLiveSubagentRunByChildSessionKey: (
      ...args: Parameters<typeof actual.getLatestLiveSubagentRunByChildSessionKey>
    ) => {
      const run = getLatestLiveSubagentRunByChildSessionKeyMock(...args);
      return run && run.childSessionKey === args[0].trim() && (!args[1] || args[1](run))
        ? run
        : null;
    },
  };
});

vi.mock("../agents/subagents/registry/subagent-registry.js", () => ({
  replaceSubagentRunAfterSteerCore: (...args: unknown[]) =>
    replaceSubagentRunAfterSteerMock(...args),
}));

import { reactivateCompletedSubagentSession } from "./session-subagent-reactivation.js";

function endedRun(
  childSessionKey: string,
  { runId = "run-prev-ended", task = "previous task", createdAt = 40 } = {},
) {
  return {
    runId,
    childSessionKey,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task,
    cleanup: "keep" as const,
    createdAt,
    execution: {
      status: "terminal" as const,
      startedAt: createdAt + 1,
      endedAt: createdAt + 2,
      outcome: { status: "ok" as const },
    },
  };
}

function mockEndedRun(run: ReturnType<typeof endedRun>) {
  getLatestSubagentRunByChildSessionKeyMock.mockResolvedValue(run);
  getLatestLiveSubagentRunByChildSessionKeyMock.mockReturnValue(run);
}

describe("reactivateCompletedSubagentSession", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    getLatestSubagentRunByChildSessionKeyMock.mockReset();
    getLatestLiveSubagentRunByChildSessionKeyMock.mockReset();
    replaceSubagentRunAfterSteerMock.mockReset();
  });

  it("skips ACP reads without a completed run and observes ACP metadata written after a native follow-up", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", label: "subagent-reactivation-acp" },
      async (state) => {
        const cfg = { agents: { ownership: "explicit" as const, entries: { main: {} } } };
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg, cfg);
        const sessionKey = "agent:main:subagent:acp-followup";
        const scope = { cfg, agentId: "main", sessionKey, env: state.env };
        let entry = await upsertSessionEntryCore(scope, {
          sessionId: "child-session",
          lifecycleRevision: "child-lifecycle",
          updatedAt: 1,
        });
        const params = {
          sessionKey,
          runId: "run-next",
          acpSession: { cfg, activeSessionAgentId: "main", sessionEntry: entry ?? undefined },
        };
        const readMetadata = vi.spyOn(acpMetadata, "readAcpSessionMetaForEntries");

        await expect(reactivateCompletedSubagentSession(params)).resolves.toBe(false);
        expect(readMetadata).not.toHaveBeenCalled();

        mockEndedRun(endedRun(sessionKey));
        replaceSubagentRunAfterSteerMock.mockReturnValue(true);
        await expect(reactivateCompletedSubagentSession(params)).resolves.toBe(true);
        expect(replaceSubagentRunAfterSteerMock).toHaveBeenCalledOnce();

        entry = await upsertAcpSessionMeta({
          ...scope,
          skipMaintenance: true,
          mutate: () => ({
            backend: "acpx",
            agent: "main",
            runtimeSessionName: "child-acp",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 2,
          }),
        });
        expect(entry).not.toBeNull();
        params.acpSession.sessionEntry = entry ?? undefined;
        await expect(reactivateCompletedSubagentSession(params)).resolves.toBe(false);
        expect(replaceSubagentRunAfterSteerMock).toHaveBeenCalledOnce();
      },
    );
  });

  it("reactivates the newest ended row even when stale active rows still exist for the same child session", async () => {
    const childSessionKey = "agent:main:subagent:followup-race";
    const resolveGatewayContext = vi.fn(() => ({ owner: "gateway-b" }) as never);
    const latestEndedRun = endedRun(childSessionKey, {
      runId: "run-current-ended",
      task: "current ended task",
      createdAt: 20,
    });

    mockEndedRun(latestEndedRun);
    replaceSubagentRunAfterSteerMock.mockReturnValue(true);

    await expect(
      reactivateCompletedSubagentSession({
        sessionKey: childSessionKey,
        runId: "run-next",
        gatewayContextResolver: resolveGatewayContext,
      }),
    ).resolves.toBe(true);

    expect(getLatestSubagentRunByChildSessionKeyMock).toHaveBeenCalledWith(childSessionKey);
    expect(replaceSubagentRunAfterSteerMock).toHaveBeenCalledWith({
      previousRunId: "run-current-ended",
      nextRunId: "run-next",
      preserveCompletedRun: true,
      assertCurrent: expect.any(Function),
      runTimeoutSeconds: 0,
      gatewayContextResolver: resolveGatewayContext,
    });
  });

  it("does not replace an ended row after its Gateway owner retires", async () => {
    mockEndedRun(endedRun("agent:main:subagent:retired-owner", { runId: "run-ended" }));
    const resolveGatewayContext = vi.fn(() => undefined);

    await expect(
      reactivateCompletedSubagentSession({
        sessionKey: "agent:main:subagent:retired-owner",
        runId: "run-next",
        gatewayContextResolver: resolveGatewayContext,
      }),
    ).resolves.toBe(false);

    expect(resolveGatewayContext).toHaveBeenCalledOnce();
    expect(replaceSubagentRunAfterSteerMock).not.toHaveBeenCalled();
  });

  it("threads the exact follow-up task into the replacement so restart redispatch rewraps the new prompt instead of the stale original", async () => {
    // Regression for the ClawSweeper P2 finding on #77539: the helper-level
    // task override reaches active steer, descendant wake, and orphan
    // recovery, but the completed-session reactivation sibling path used by
    // sessions.send and agent run dispatch was passing only sessionKey + runId.
    // After a gateway restart the orphan recovery would rewrap the stale
    // `task` from the previous run instead of the canonical follow-up text.
    const childSessionKey = "agent:main:subagent:reactivate-with-task";
    const latestEndedRun = endedRun(childSessionKey, {
      task: "stale original task",
      createdAt: 30,
    });

    mockEndedRun(latestEndedRun);
    replaceSubagentRunAfterSteerMock.mockReturnValue(true);

    await expect(
      reactivateCompletedSubagentSession({
        sessionKey: childSessionKey,
        runId: "run-next",
        task: "  follow-up prompt text  ",
      }),
    ).resolves.toBe(true);

    expect(replaceSubagentRunAfterSteerMock).toHaveBeenCalledWith({
      previousRunId: "run-prev-ended",
      nextRunId: "run-next",
      preserveCompletedRun: true,
      assertCurrent: expect.any(Function),
      runTimeoutSeconds: 0,
      task: "  follow-up prompt text  ",
    });
  });

  it("rejects an accepted run when another replacement owns the child session", async () => {
    const childSessionKey = "agent:main:subagent:replacement-race";
    mockEndedRun(endedRun(childSessionKey));
    replaceSubagentRunAfterSteerMock.mockImplementationOnce(() => {
      getLatestLiveSubagentRunByChildSessionKeyMock.mockReturnValue(
        endedRun(childSessionKey, { runId: "run-other-successor" }),
      );
      return false;
    });

    await expect(
      reactivateCompletedSubagentSession({
        sessionKey: childSessionKey,
        runId: "run-losing-successor",
      }),
    ).rejects.toThrow("subagent follow-up owner replacement was rejected");
  });

  it("keeps an accepted run that already owns the child session", async () => {
    const childSessionKey = "agent:main:subagent:already-replaced";
    mockEndedRun(endedRun(childSessionKey));
    replaceSubagentRunAfterSteerMock.mockImplementationOnce(() => {
      getLatestLiveSubagentRunByChildSessionKeyMock.mockReturnValue(
        endedRun(childSessionKey, { runId: "run-next" }),
      );
      return false;
    });

    await expect(
      reactivateCompletedSubagentSession({
        sessionKey: childSessionKey,
        runId: "run-next",
      }),
    ).resolves.toBe(true);
  });
});
