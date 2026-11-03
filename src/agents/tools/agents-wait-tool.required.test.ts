import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { recoverStuckDiagnosticSession } from "../../logging/diagnostic-stuck-session-recovery.runtime.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { applyCodeModeCatalog } from "../code-mode.js";
import { createCodeModeHarness, resetCodeModeTestState } from "../code-mode.test-support.js";
import { resolveActiveEmbeddedRunRecoveryBlocker } from "../embedded-agent-runner/run-state.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "../embedded-agent-runner/runs.js";
import type { PreparedSubagentRunsRead } from "../subagents/registry/subagent-registry-read-snapshot.js";
import type { SubagentRunRecord } from "../subagents/registry/subagent-registry.types.js";
import { createAgentsWaitTool } from "./agents-wait-tool.js";
import { collectorRun } from "./agents-wait-tool.test-support.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";

const records = new Map<string, SubagentRunRecord>();
const registryEvents = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  read: vi.fn<(ids: readonly string[]) => Promise<PreparedSubagentRunsRead>>(),
}));
vi.mock("../subagents/registry/subagent-registry.js", () => ({
  prepareSubagentRunsByRunIds: registryEvents.read,
}));
vi.mock("../subagents/registry/subagent-registry-publication.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../subagents/registry/subagent-registry-publication.js")>();
  return {
    ...actual,
    subscribeSubagentRunChanges: ((phase, listener) => {
      if (phase === "projection") {
        return actual.subscribeSubagentRunChanges(phase, listener);
      }
      const wake = () => listener({ runIds: undefined, sessionKeys: undefined });
      registryEvents.listeners.add(wake);
      return () => registryEvents.listeners.delete(wake);
    }) satisfies typeof actual.subscribeSubagentRunChanges,
  };
});
function selectRuns(ids: readonly string[]) {
  return new Map(
    ids.flatMap((id) => {
      const entry = records.get(id);
      return entry ? [[id, entry] as const] : [];
    }),
  );
}
function preparedRuns(
  read: () => ReadonlyMap<string, SubagentRunRecord>,
): PreparedSubagentRunsRead {
  return { consume: (consume) => ({ ready: true, value: consume(read()) }) };
}
function createMainSessionWaitTool() {
  return createAgentsWaitTool({
    agentSessionKey: "agent:main:main",
    agentId: "main",
    config: { tools: { swarm: true } },
  });
}

describe("required collector completion", () => {
  beforeEach(() => {
    records.clear();
    registryEvents.listeners.clear();
    registryEvents.read
      .mockReset()
      .mockImplementation(async (ids) => preparedRuns(() => selectRuns(ids)));
  });
  it.each([
    { outcome: "done", codeMode: true },
    { outcome: "failed", codeMode: false },
    { outcome: "aborted", codeMode: false },
    { outcome: "revoked caller authority", codeMode: false },
    { outcome: "stalled reread", codeMode: false },
  ] as const)(
    "keeps a long collector wait alive until $outcome (Code Mode: $codeMode)",
    async ({ outcome, codeMode }) => {
      const h = createCodeModeHarness({ agentId: "main" });
      onTestFinished(resetCodeModeTestState);
      const { sessionId, sessionKey, runId } = h.ctx;
      const admission = prepareSystemAgentRunAdmission({}, runId, "main", "wait-test");
      const admitted = await admission.admit("embedded");
      const callerApproval = new AbortController();
      const caller = createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: admitted,
        agentId: "main",
        sessionKey,
        approvalSignals: [callerApproval.signal],
      });
      const signal = new AbortController();
      const stalledReread = createDeferred<PreparedSubagentRunsRead>();
      const abort = vi.fn(() => {
        signal.abort();
        clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      });
      const handle = {
        runId,
        queueMessage: async () => {},
        isStreaming: () => true,
        isCompacting: () => false,
        isAborted: () => signal.signal.aborted,
        abort,
      };
      const entry = collectorRun("long-collector", sessionKey);
      records.set(entry.runId, entry);
      const read = createDeferred();
      registryEvents.read.mockImplementation(async (ids) =>
        preparedRuns(() => {
          read.resolve();
          return selectRuns(ids);
        }),
      );
      const tool = createMainSessionWaitTool();
      applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, tool] });
      await withGatewayToolCallerIdentity(caller, () =>
        setActiveEmbeddedRun(sessionId, handle, sessionKey),
      );
      const result = withGatewayToolCallerIdentity(caller, () =>
        (codeMode ? expectDefined(h.tools[0], "exec") : tool).execute(
          "join",
          codeMode
            ? {
                title: "Join required child",
                awaitResults: true,
                code: 'return await agents_wait({ids:["long-collector"], awaitResults:true});',
              }
            : { ids: [entry.runId], awaitResults: true },
          signal.signal,
        ),
      );
      // Always observe cancellation, including when the pre-fix recovery aborts the parent.
      const observed = result.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await read.promise;
        vi.useFakeTimers();
        await vi.advanceTimersByTimeAsync(16 * 60_000);
        await expect(
          recoverStuckDiagnosticSession({
            sessionId,
            sessionKey,
            ageMs: 16 * 60_000,
            queueDepth: 0,
            allowActiveAbort: true,
          }),
        ).resolves.toMatchObject({ status: "skipped", reason: "runtime_owned_wait" });
        expect(abort).not.toHaveBeenCalled();
        expect(registryEvents.read).toHaveBeenCalledOnce();

        if (outcome === "revoked caller authority" || outcome === "stalled reread") {
          if (outcome === "revoked caller authority") {
            callerApproval.abort();
          } else {
            registryEvents.read.mockImplementation(() => stalledReread.promise);
            for (const listener of registryEvents.listeners) {
              listener();
            }
          }
          // Neither a revoked caller nor a hung registry reread may park the parent.
          expect(resolveActiveEmbeddedRunRecoveryBlocker(sessionId)).toBeUndefined();
          signal.abort();
          stalledReread.resolve(preparedRuns(() => selectRuns([entry.runId])));
          vi.useRealTimers();
          await expect(result).rejects.toThrow("agents_wait aborted");
        } else if (outcome === "aborted") {
          signal.abort();
          await expect(result).rejects.toThrow("agents_wait aborted");
        } else {
          entry.collectorCompletion = { status: outcome };
          entry.completion = { required: false, resultText: "collected result" };
          for (const listener of registryEvents.listeners) {
            listener();
          }
          vi.useRealTimers();
          const completed = {
            completed: [{ runId: entry.runId, status: outcome, result: "collected result" }],
            pending: [],
          };
          await expect(result).resolves.toMatchObject({
            details: codeMode ? { status: "completed", value: completed } : completed,
          });
        }
        expect(resolveActiveEmbeddedRunRecoveryBlocker(sessionId)).toBeUndefined();
        expect(registryEvents.listeners.size).toBe(0);
      } finally {
        signal.abort();
        await observed;
        clearActiveEmbeddedRun(sessionId, handle, sessionKey);
        admission.close();
        resetDiagnosticEventsForTest();
        vi.useRealTimers();
      }
    },
  );
  it.each(["cell", "nested"])(
    "keeps sibling results owned with %s awaitResults until every completion arrives",
    async (mode) => {
      onTestFinished(resetCodeModeTestState);
      const first = collectorRun("first-required", "agent:main:main", { status: "done" });
      const second = collectorRun("second-required", "agent:main:main");
      records.set(first.runId, first);
      records.set(second.runId, second);
      const read = createDeferred();
      registryEvents.read.mockImplementation(async (ids) => {
        read.resolve();
        return preparedRuns(() => selectRuns(ids));
      });
      const h = createCodeModeHarness();
      applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, createMainSessionWaitTool()] });
      let settled = false;
      const result = expectDefined(h.tools[0], "exec")
        .execute("required-child-results", {
          title: "Collect required child results",
          awaitResults: mode === "cell",
          code: `return await agents_wait({ids:["first-required", "second-required"]${mode === "nested" ? ", awaitResults: true" : ""}});`,
        })
        .then((value) => {
          settled = true;
          return value;
        });
      try {
        await read.promise;
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(settled).toBe(false);
        expect(registryEvents.read).toHaveBeenCalledOnce();
        second.completion = { required: false, resultText: "child failure evidence" };
        second.collectorCompletion = { status: "failed" };
        for (const listener of registryEvents.listeners) {
          listener();
        }
        vi.useRealTimers();
        await expect(result).resolves.toMatchObject({
          details: {
            status: "completed",
            value: {
              pending: [],
              completed: [
                { runId: first.runId, status: "done" },
                { runId: second.runId, status: "failed", result: "child failure evidence" },
              ],
            },
          },
        });
        expect(registryEvents.read).toHaveBeenCalledTimes(2);
        expect(registryEvents.listeners.size).toBe(0);
      } finally {
        vi.useRealTimers();
        second.collectorCompletion = { status: "failed" };
        for (const listener of registryEvents.listeners) {
          listener();
        }
        await result;
      }
    },
  );

  it("cancels required collection without borrowing another requester's child", async () => {
    const entry = collectorRun("foreign-required", "agent:other:main");
    records.set(entry.runId, entry);
    const tool = createMainSessionWaitTool();
    await expect(
      tool.execute("foreign", { ids: [entry.runId], awaitResults: true }),
    ).resolves.toMatchObject({
      details: { success: false, errors: [{ runId: entry.runId, error: "not_owner" }] },
    });
    entry.swarmRequesterSessionKey = "agent:main:main";
    const read = createDeferred();
    registryEvents.read.mockImplementation(async (ids) => {
      read.resolve();
      return preparedRuns(() => selectRuns(ids));
    });
    const abort = new AbortController();
    const result = tool.execute(
      "required-abort",
      { ids: [entry.runId], awaitResults: true },
      abort.signal,
    );
    const rejected = expect(result).rejects.toThrow("agents_wait aborted");
    await read.promise;
    abort.abort();
    await rejected;
    expect(registryEvents.listeners.size).toBe(0);
    await expect(
      tool.execute("ambiguous-wait", { ids: [entry.runId], awaitResults: true, timeoutSeconds: 1 }),
    ).rejects.toThrow("cannot also specify");
  });
});
