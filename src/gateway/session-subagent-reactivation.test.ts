import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as acpMetadata from "../acp/runtime/session-meta-readonly.js";
import { upsertAcpSessionMeta } from "../acp/runtime/session-meta-write.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const latestRun = vi.fn();
const liveRun = vi.fn();
const replaceSubagentRunAfterSteerMock = vi.fn();

vi.mock("../agents/subagents/registry/subagent-registry-read.js", async () => {
  const actual = await vi.importActual<
    typeof import("../agents/subagents/registry/subagent-registry-read.js")
  >("../agents/subagents/registry/subagent-registry-read.js");
  return {
    ...actual,
    getLatestSubagentRunByChildSessionKey: (...args: unknown[]) => latestRun(...args),
    getLatestLiveSubagentRunByChildSessionKey: (
      ...args: Parameters<typeof actual.getLatestLiveSubagentRunByChildSessionKey>
    ) => {
      const run = liveRun(...args);
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

const childSessionKey = "agent:main:subagent:followup";

function endedRun({ runId = "run-prev-ended", task = "previous task" } = {}) {
  return {
    runId,
    childSessionKey,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task,
    cleanup: "keep" as const,
    createdAt: 40,
    execution: {
      status: "terminal" as const,
      startedAt: 41,
      endedAt: 42,
      outcome: { status: "ok" as const },
    },
  };
}

function mockEndedRun(run: ReturnType<typeof endedRun>) {
  latestRun.mockResolvedValue(run);
  liveRun.mockReturnValue(run);
  replaceSubagentRunAfterSteerMock.mockReturnValue(true);
}

function reactivate(
  overrides: Partial<Parameters<typeof reactivateCompletedSubagentSession>[0]> = {},
) {
  return reactivateCompletedSubagentSession({
    sessionKey: childSessionKey,
    runId: "run-next",
    ...overrides,
  });
}

function expectReplacement(overrides: Record<string, unknown>) {
  expect(replaceSubagentRunAfterSteerMock).toHaveBeenCalledWith({
    previousRunId: "run-prev-ended",
    nextRunId: "run-next",
    preserveCompletedRun: true,
    assertCurrent: expect.any(Function),
    runTimeoutSeconds: 0,
    ...overrides,
  });
}

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  latestRun.mockReset();
  liveRun.mockReset();
  replaceSubagentRunAfterSteerMock.mockReset();
});

it("skips ACP reads without an ended run and observes newly written ACP metadata", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "subagent-reactivation-acp" },
    async (state) => {
      const cfg = { agents: { ownership: "explicit" as const, entries: { main: {} } } };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg, cfg);
      const scope = { cfg, agentId: "main", sessionKey: childSessionKey, env: state.env };
      let entry = await upsertSessionEntryCore(scope, {
        sessionId: "child-session",
        lifecycleRevision: "child-lifecycle",
        updatedAt: 1,
      });
      const params = {
        sessionKey: childSessionKey,
        runId: "run-next",
        acpSession: { cfg, activeSessionAgentId: "main", sessionEntry: entry ?? undefined },
      };
      const readMetadata = vi.spyOn(acpMetadata, "readAcpSessionMetaForEntries");

      await expect(reactivateCompletedSubagentSession(params)).resolves.toBe(false);
      expect(readMetadata).not.toHaveBeenCalled();

      mockEndedRun(endedRun());
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

it("reactivates the newest ended row despite stale active rows", async () => {
  const resolveGatewayContext = vi.fn(() => ({ owner: "gateway-b" }) as never);
  mockEndedRun(endedRun({ runId: "run-current-ended" }));
  await expect(reactivate({ gatewayContextResolver: resolveGatewayContext })).resolves.toBe(true);

  expect(latestRun).toHaveBeenCalledWith(childSessionKey);
  expectReplacement({
    previousRunId: "run-current-ended",
    gatewayContextResolver: resolveGatewayContext,
  });
});

it("does not replace an ended row after its Gateway owner retires", async () => {
  mockEndedRun(endedRun({ runId: "run-ended" }));
  const resolveGatewayContext = vi.fn(() => undefined);

  await expect(reactivate({ gatewayContextResolver: resolveGatewayContext })).resolves.toBe(false);

  expect(resolveGatewayContext).toHaveBeenCalledOnce();
  expect(replaceSubagentRunAfterSteerMock).not.toHaveBeenCalled();
});

it("preserves the exact follow-up task for restart redispatch (#77539)", async () => {
  mockEndedRun(endedRun({ task: "stale original task" }));
  await expect(reactivate({ task: "  follow-up prompt text  " })).resolves.toBe(true);

  expectReplacement({ task: "  follow-up prompt text  " });
});

it.each([false, true])("accepts a replacement only when it owns the child (%s)", async (owns) => {
  mockEndedRun(endedRun());
  replaceSubagentRunAfterSteerMock.mockImplementationOnce(() => {
    liveRun.mockReturnValue(endedRun({ runId: owns ? "run-next" : "run-other-successor" }));
    return false;
  });

  const pending = reactivate();
  if (owns) {
    await expect(pending).resolves.toBe(true);
  } else {
    await expect(pending).rejects.toThrow("subagent follow-up owner replacement was rejected");
  }
});
