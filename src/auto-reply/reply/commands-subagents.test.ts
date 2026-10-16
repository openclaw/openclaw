// Keep subagent command assertions together to share the auto-reply module graph.
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { configureMockSubagentRegistryPersistence } from "../../agents/subagent-test-fixtures.test-helpers.js";
import * as controlScope from "../../agents/subagents/registry/subagent-control-scope.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "../../agents/subagents/registry/subagent-lifecycle-events.js";
import { captureSubagentListReadContext } from "../../agents/subagents/registry/subagent-list.js";
import { SubagentLifecycleController } from "../../agents/subagents/registry/subagent-registry-lifecycle.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../../agents/subagents/registry/subagent-registry-persistence.js";
import { buildSubagentRunReadIndexFromRuns } from "../../agents/subagents/registry/subagent-registry-queries.js";
import {
  addSubagentRunForTests,
  seedSubagentRunForReadTest,
  releaseSubagentRun,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import * as sessionReads from "../../config/sessions/session-entry-read-runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { ReplyPayload } from "../types.js";
import { buildSubagentsStatusLine } from "./commands-status-subagents.js";
import { handleSubagentsCommand } from "./commands-subagents.js";
import { handleSubagentsInfoAction } from "./commands-subagents/action-info.js";
import { handleSubagentsListAction } from "./commands-subagents/action-list.js";
import { handleSubagentsLogAction } from "./commands-subagents/action-log.js";
import { baseCommandTestConfig, buildCommandTestParams } from "./commands.test-harness.js";

const callGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/call.js", () => ({
  callGateway: (params: unknown) => callGatewayMock(params),
}));

function requireReplyText(reply: ReplyPayload | undefined): string {
  if (reply?.text === undefined) {
    throw new Error("expected reply text");
  }
  return reply.text;
}

function expectText(text: string, included: string[], excluded: string[] = []) {
  for (const value of included) {
    expect(text).toContain(value);
  }
  for (const value of excluded) {
    expect(text).not.toContain(value);
  }
}

function commandRun(
  fields: Omit<SubagentRunRecord, "requesterSessionKey" | "requesterDisplayKey" | "cleanup"> &
    Partial<Pick<SubagentRunRecord, "requesterSessionKey" | "requesterDisplayKey" | "cleanup">>,
): SubagentRunRecord {
  return {
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    cleanup: "keep",
    ...fields,
  };
}

function commandReadContext(runs: SubagentRunRecord[]) {
  const snapshot = new Map(runs.map((run) => [run.runId, run]));
  const index = buildSubagentRunReadIndexFromRuns({ runs: snapshot });
  return {
    list: captureSubagentListReadContext(runs, index, snapshot, 30),
  };
}

afterEach(async () => {
  await resetSubagentRegistryForTests({ persist: false });
  clearRuntimeConfigSnapshot();
});

describe("subagents status", () => {
  beforeEach(async () => {
    await resetSubagentRegistryForTests({ persist: false });
    setRuntimeConfigSnapshot(baseCommandTestConfig);
  });

  it("preserves verbose done-only summary", async () => {
    seedSubagentRunForReadTest({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:done-a",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "finished task",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
      endedAt: 2000,
      outcome: { status: "ok" },
    });
    const text =
      buildSubagentsStatusLine({
        context: await controlScope.buildControlledSubagentRunsReadContext("agent:main:main"),
        verboseEnabled: true,
        now: 5000,
      }) ?? "";
    expectText(text, ["🤖 Subagents: 0 active · 1 done"], ["  • finished task"]);
  });

  it("keeps the newest three details and two pending children in the full counts", async () => {
    const children = 2;
    const now = Date.now();
    const parentKey = "agent:main:subagent:tie-a";
    for (const [name, ageMs, ended] of [
      ["tie-b", 2_000, false],
      ["done", 3_000, true],
      ["oldest", 4_000, false],
      ["first", 1_000, false],
      ["tie-a", 2_000, true],
      ["stale", 3 * 60 * 60_000, false],
    ] as const) {
      seedSubagentRunForReadTest({
        runId: name,
        childSessionKey: `agent:main:subagent:${name}`,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: `${name} worker`,
        cleanup: "keep",
        createdAt: now - ageMs,
        startedAt: now - ageMs,
        endedAt: ended ? now - 500 : undefined,
      });
    }
    for (let index = 0; index < children; index++) {
      seedSubagentRunForReadTest({
        runId: `child-${index}`,
        childSessionKey: `${parentKey}:subagent:${index}`,
        requesterSessionKey: parentKey,
        requesterDisplayKey: "tie-a",
        task: "pending child",
        cleanup: "keep",
        createdAt: now - 1_000,
        startedAt: now - 1_000,
        endedAt: index > 0 ? now - 500 : undefined,
      });
    }

    const text = buildSubagentsStatusLine({
      context: await controlScope.buildControlledSubagentRunsReadContext("agent:main:main"),
      verboseEnabled: true,
      now,
    });
    const details = text?.split("\n").slice(1);

    expect(text).toContain("Subagents: 4 active · 1 done");
    expect(details).toEqual([
      expect.stringContaining("first worker"),
      expect.stringContaining("tie-b worker"),
      expect.stringContaining("tie-a worker"),
    ]);
    expect(details?.[0]).toContain("1s");
    expect(details?.[1]).toContain("2s");
    expect(details?.[2]).toContain("2s");
    expect(details?.[2]).toMatch(new RegExp(`\\b${children} child`));
  });

  it("preserves active duration for non-finite end Infinity", async () => {
    const run = commandRun({
      runId: "non-finite-end",
      childSessionKey: "agent:main:subagent:non-finite-end",
      task: "active worker",
      createdAt: 1_000,
      execution: { status: "running", startedAt: 1_000, endedAt: Infinity },
    });
    seedSubagentRunForReadTest(run);
    const text = buildSubagentsStatusLine({
      context: await controlScope.buildControlledSubagentRunsReadContext("agent:main:main"),
      verboseEnabled: false,
      now: 5_000,
    });
    expect(text).toContain("Subagents: 1 active");
    expect(text).toContain("active worker · 0s");
  });
});

describe("subagents command snapshots", () => {
  beforeEach(async () => {
    await resetSubagentRegistryForTests({ persist: false });
    setRuntimeConfigSnapshot(baseCommandTestConfig);
    await configureMockSubagentRegistryPersistence({ persistRegistryRows: () => {} });
  });

  it("renders the captured controlled run and descendant facts after a concurrent settlement", async () => {
    const parent = commandRun({
      runId: "paired-parent",
      childSessionKey: "agent:main:subagent:paired-parent",
      task: "paired parent",
      createdAt: Date.now() - 2_000,
      execution: { status: "terminal", endedAt: Date.now() - 1_000 },
    });
    const child = {
      ...parent,
      runId: "paired-child",
      childSessionKey: "agent:main:subagent:paired-child",
      requesterSessionKey: parent.childSessionKey,
      execution: { status: "running", startedAt: Date.now() },
    } satisfies SubagentRunRecord;
    seedSubagentRunForReadTest(parent);
    seedSubagentRunForReadTest(child);
    const prepare = controlScope.buildControlledSubagentRunsReadContext;
    const snapshot = vi
      .spyOn(controlScope, "buildControlledSubagentRunsReadContext")
      .mockImplementation(async (...args) => {
        const context = await prepare(...args);
        await mutateSubagentRuns([parent.runId, child.runId], (rows) => {
          const currentParent = rows.get(parent.runId);
          const currentChild = rows.get(child.runId);
          if (!currentParent || !currentChild) {
            throw new Error("Expected both captured subagent rows");
          }
          return {
            value: undefined,
            postimages: new Map([
              [parent.runId, { ...currentParent, task: "changed after preparation" }],
              [
                child.runId,
                {
                  ...currentChild,
                  execution: { status: "terminal" as const, endedAt: Date.now() },
                  cleanupCompletedAt: Date.now(),
                },
              ],
            ]),
          };
        });
        return context;
      });
    try {
      const result = await handleSubagentsCommand(
        buildCommandTestParams("/subagents list", baseCommandTestConfig),
        true,
      );
      const text = requireReplyText(result?.reply);
      expect(text).toContain("active (waiting on 1 child)");
      expect(text).toContain("paired parent");
      expect(text).not.toContain("changed after preparation");
    } finally {
      snapshot.mockRestore();
    }
  });

  it("captures controlled runs after lazy action loading", async () => {
    const controllerSessionKey = "agent:main:main";
    const parentSessionKey = "agent:main:subagent:snapshot-parent";
    const parentRunId = "snapshot-parent-run";

    await handleSubagentsCommand(
      buildCommandTestParams("/subagents list", baseCommandTestConfig),
      true,
    );
    seedSubagentRunForReadTest({
      runId: parentRunId,
      childSessionKey: parentSessionKey,
      childSessionIdentity: { sessionId: "snapshot-parent-session" },
      controllerSessionKey,
      requesterSessionKey: controllerSessionKey,
      requesterDisplayKey: "main",
      task: "removed parent",
      cleanup: "keep",
      createdAt: Date.now() - 2_000,
      startedAt: Date.now() - 2_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
    });

    const prepare = controlScope.buildControlledSubagentRunsReadContext;
    const snapshot = vi
      .spyOn(controlScope, "buildControlledSubagentRunsReadContext")
      .mockImplementationOnce(async (...args) => {
        await releaseSubagentRun(parentRunId);
        await addSubagentRunForTests({
          runId: "snapshot-child-run",
          childSessionKey: `${parentSessionKey}:subagent:child`,
          controllerSessionKey: parentSessionKey,
          requesterSessionKey: parentSessionKey,
          requesterDisplayKey: parentSessionKey,
          task: "new child",
          cleanup: "keep",
          createdAt: Date.now(),
          startedAt: Date.now(),
        });
        return prepare(...args);
      });
    try {
      const reply = await handleSubagentsCommand(
        buildCommandTestParams("/agents", baseCommandTestConfig),
        true,
      );
      const text = requireReplyText(reply?.reply);
      expect(text).toContain("(none)");
      expect(text).not.toContain("removed parent");
      expect(text).not.toContain("waiting on 1 child");
    } finally {
      snapshot.mockRestore();
    }
  });
});

describe("subagents global-session inspection", () => {
  const cfg: OpenClawConfig = {
    ...baseCommandTestConfig,
    agents: { ownership: "explicit", entries: { research: {}, ops: {} } },
    session: { scope: "global" },
  };

  beforeEach(async () => {
    await resetSubagentRegistryForTests({ persist: false });
    setRuntimeConfigSnapshot(cfg);
    callGatewayMock.mockReset().mockResolvedValue({ messages: [] });
    for (const agentId of ["research", "ops"]) {
      seedSubagentRunForReadTest({
        runId: `global-${agentId}`,
        childSessionKey: `agent:${agentId}:subagent:worker`,
        controllerSessionKey: "global",
        requesterSessionKey: "global",
        requesterAgentId: agentId,
        requesterDisplayKey: "global",
        task: `${agentId} worker`,
        cleanup: "keep",
        createdAt: Date.now() - 1_000,
        startedAt: Date.now() - 1_000,
      });
    }
  });

  it.each(["/subagents info 1", "/subagents log 1", "/agents"])(
    "keeps the selected agent's global children visible through %s",
    async (command) => {
      const params = buildCommandTestParams(command, cfg, { SessionKey: "global" });
      params.sessionKey = "global";
      params.agentId = "research";

      const result = await handleSubagentsCommand(params, true);
      const text = requireReplyText(result?.reply);

      expect(text).toContain("research worker");
      expect(text).not.toContain("ops worker");
      if (command === "/subagents log 1") {
        expect(callGatewayMock).toHaveBeenCalledWith({
          method: "chat.history",
          params: { sessionKey: "agent:research:subagent:worker", limit: 20 },
        });
      }
    },
  );
});

describe("subagents info", () => {
  const TEST_SESSION_STORE_PATH = path.join(
    os.tmpdir(),
    `openclaw-commands-subagents-info-${process.pid}.json`,
  );

  function buildCommandTestConfig(): OpenClawConfig {
    return {
      ...baseCommandTestConfig,
      session: {
        ...baseCommandTestConfig.session,
        store: TEST_SESSION_STORE_PATH,
      },
    };
  }

  function buildInfoContext(params: {
    cfg: OpenClawConfig;
    runs: SubagentRunRecord[];
    restTokens: string[];
  }): Parameters<typeof handleSubagentsInfoAction>[0] {
    const runs = params.runs.map(({ runId }) => {
      const run = subagentRuns.get(runId);
      if (!run) {
        throw new Error(`Info fixture has no registered run: ${runId}`);
      }
      return run;
    });
    return {
      params: buildCommandTestParams("/subagents info", params.cfg),
      requesterKey: "agent:main:main",
      readContext: commandReadContext(runs),
      restTokens: params.restTokens,
    };
  }

  beforeEach(async () => {
    await resetSubagentRegistryForTests({ persist: false });
    setRuntimeConfigSnapshot(buildCommandTestConfig());
  });

  it("reads a raw child's session id from its recorded agent", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {
        session: { store: state.statePath("agents/{agentId}/sessions/sessions.json") },
      };
      setRuntimeConfigSnapshot(cfg);
      for (const agentId of ["main", "research"]) {
        await replaceSessionEntry(
          { agentId, sessionKey: "global" },
          { sessionId: `${agentId}-session`, updatedAt: 1 },
        );
      }
      const run = commandRun({
        runId: "research-info",
        childSessionKey: "global",
        childAgentId: "research",
        task: "Inspect the recorded child",
        createdAt: Date.now(),
        execution: { status: "running", startedAt: Date.now() },
      });
      seedSubagentRunForReadTest(run);
      const result = await handleSubagentsInfoAction(
        buildInfoContext({
          cfg,
          runs: [run],
          restTokens: [run.runId],
        }),
      );
      expect(requireReplyText(result.reply)).toContain("SessionId: research-session");
      expect(requireReplyText(result.reply)).not.toContain("SessionId: main-session");
    });
  });

  it("refuses info after its selected run changes controllers during the child read", async () => {
    const run = commandRun({
      runId: "held-info-run",
      childSessionKey: "agent:main:subagent:held-info",
      task: "Inspect the original child",
      createdAt: Date.now(),
      execution: { status: "running", startedAt: Date.now() },
    });
    seedSubagentRunForReadTest(run);
    const entered = createDeferred();
    const release = createDeferred();
    const read = sessionReads.withSessionEntryReadOnlyInWorker;
    const held = vi
      .spyOn(sessionReads, "withSessionEntryReadOnlyInWorker")
      .mockImplementation((input, assertCurrent, consume, ...rest) =>
        read(
          input,
          assertCurrent,
          async (...result) => {
            entered.resolve();
            await release.promise;
            return consume(...result);
          },
          ...rest,
        ),
      );
    const result = handleSubagentsInfoAction(
      buildInfoContext({ cfg: buildCommandTestConfig(), runs: [run], restTokens: [run.runId] }),
    );
    try {
      await awaitGateBeforeSettlement(entered.promise, result, "Info did not reach its child read");
      seedSubagentRunForReadTest({ ...run, controllerSessionKey: "agent:main:other-controller" });
      release.resolve();
      await expect(result).rejects.toThrow("selected subagent run changed");
    } finally {
      release.resolve();
      await result.catch(() => {});
      held.mockRestore();
    }
  });

  it("returns usage for missing targets", async () => {
    const cfg = {
      commands: { text: true },
      channels: { quietchat: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const result = await handleSubagentsInfoAction(
      buildInfoContext({ cfg, runs: [], restTokens: [] }),
    );
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("/subagents info <id|#>");
  });

  it("returns info for a subagent with discard reason=expired", async () => {
    const discardReason = "expired";
    const now = Date.now();
    const runId = "commands-subagents-info-run";
    const childSessionKey = "agent:main:subagent:commands-info";
    const run = commandRun({
      runId,
      childSessionKey,
      task: "do thing",
      completion: { required: true, resultText: "Completed the requested task" },
      createdAt: now - 20_000,
      execution: {
        status: "terminal",
        startedAt: now - 20_000,
        endedAt: now - 8 * 24 * 60 * 60_000,
        outcome: { status: "ok" },
      },
    });
    run.delivery = {
      status: "suspended",
      suspendedAt: now - 7 * 24 * 60 * 60_000,
      suspendedReason: "permanent_failure",
      lastError: "requester unavailable\ntry retained result",
    };
    SubagentLifecycleController.discardTerminalDelivery(run, now, discardReason);
    expect(run.delivery.lastError).toBeUndefined();
    seedSubagentRunForReadTest(run);
    const cfg = buildCommandTestConfig();
    const result = await handleSubagentsInfoAction(
      buildInfoContext({ cfg, runs: [run], restTokens: [runId] }),
    );
    const text = requireReplyText(result.reply);
    expect(result.shouldContinue).toBe(false);
    expectText(text, [
      "Subagent info",
      `Run: ${runId}`,
      "Status: done",
      "Outcome: ok",
      "Progress: Completed the requested task",
      "Delivery: discarded",
      `Delivery disposition: ${discardReason}`,
      `Delivery retired: ${new Date(now).toISOString()}`,
      "Task summary: requester unavailable try retained result",
    ]);
  });

  it("uses displayed indices for info and log when stale unended runs exist", async () => {
    const now = Date.now();
    const runs: SubagentRunRecord[] = [
      {
        runId: "numbering-stale",
        childSessionKey: "agent:main:subagent:numbering-stale",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "stale worker",
        cleanup: "keep",
        createdAt: now - 3 * 60 * 60_000,
        execution: { status: "running", startedAt: now - 3 * 60 * 60_000 },
      },
      {
        runId: "numbering-recent",
        childSessionKey: "agent:main:subagent:numbering-recent",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "recent worker",
        cleanup: "keep",
        createdAt: now - 120_000,
        execution: {
          status: "terminal",
          startedAt: now - 120_000,
          endedAt: now - 60_000,
          outcome: { status: "ok" },
        },
      },
    ];
    for (const run of runs) {
      seedSubagentRunForReadTest(run);
    }
    const context = buildInfoContext({ cfg: buildCommandTestConfig(), runs, restTokens: ["1"] });
    const listing = requireReplyText((await handleSubagentsListAction(context)).reply);
    expect(listing).toContain("1. recent worker");
    expect(listing).not.toContain("stale worker");
    expect(requireReplyText((await handleSubagentsInfoAction(context)).reply)).toContain(
      "Run: numbering-recent",
    );
    callGatewayMock.mockResolvedValue({ messages: [] });
    await handleSubagentsLogAction(context);
    expect(callGatewayMock).toHaveBeenLastCalledWith({
      method: "chat.history",
      params: { sessionKey: "agent:main:subagent:numbering-recent", limit: 20 },
    });
  });

  it("keeps info and list aligned for a killed run despite its provider error", async () => {
    const expectedStatus = "killed";
    const now = Date.now();
    const run = commandRun({
      runId: `commands-subagents-status-${expectedStatus}`,
      childSessionKey: `agent:main:subagent:commands-status-${expectedStatus}`,
      task: "report the actual child outcome",
      createdAt: now - 2_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: {
        status: "terminal",
        startedAt: now - 2_000,
        endedAt: now - 1_000,
        outcome: { status: "error", error: "agent run aborted" },
      },
    });
    seedSubagentRunForReadTest(run);
    const context = buildInfoContext({
      cfg: buildCommandTestConfig(),
      runs: [run],
      restTokens: ["1"],
    });

    expect(requireReplyText((await handleSubagentsInfoAction(context)).reply)).toContain(
      `Status: ${expectedStatus}`,
    );
    expect(requireReplyText((await handleSubagentsListAction(context)).reply)).toContain(
      ` ${expectedStatus}`,
    );
  });

  it("omits Date-invalid subagent timestamps", async () => {
    const runId = "commands-subagents-info-invalid-date-run";
    const childSessionKey = "agent:main:subagent:commands-info-invalid-date";
    const run = commandRun({
      runId,
      childSessionKey,
      task: "inspect invalid timestamps",
      createdAt: 8_640_000_000_000_001,
      archiveAtMs: 8_640_000_000_000_001,
      execution: {
        status: "terminal",
        startedAt: 8_640_000_000_000_001,
        endedAt: 8_640_000_000_000_001,
        outcome: { status: "ok" },
      },
    });
    seedSubagentRunForReadTest(run);
    const cfg = buildCommandTestConfig();

    const result = await handleSubagentsInfoAction(
      buildInfoContext({ cfg, runs: [run], restTokens: ["1"] }),
    );

    const text = requireReplyText(result.reply);
    expect(result.shouldContinue).toBe(false);
    expectText(
      text,
      [`Run: ${runId}`, "Created: n/a", "Started: n/a", "Ended: n/a", "Archive: n/a"],
      ["Invalid Date"],
    );
  });

  it("sanitizes leaked task details in /subagents info", async () => {
    const now = Date.now();
    const runId = "commands-subagents-info-leak-run";
    const childSessionKey = "agent:main:subagent:commands-info-leak";
    const run = commandRun({
      runId,
      childSessionKey,
      task: "Inspect the stuck run",
      delivery: { status: "suspended", lastError: "Needs manual follow-up." },
      createdAt: now - 20_000,
      execution: {
        status: "terminal",
        startedAt: now - 20_000,
        endedAt: now - 1_000,
        outcome: {
          status: "error",
          error: [
            "OpenClaw runtime context (internal):",
            "This context is runtime-generated, not user-authored. Keep internal details private.",
            "",
            "[Internal task completion event]",
            "source: subagent",
          ].join("\n"),
        },
      },
    });
    seedSubagentRunForReadTest(run);
    const cfg = buildCommandTestConfig();
    const result = await handleSubagentsInfoAction(
      buildInfoContext({ cfg, runs: [run], restTokens: ["1"] }),
    );
    const text = requireReplyText(result.reply);

    expect(result.shouldContinue).toBe(false);
    expectText(
      text,
      ["Subagent info", "Outcome: error", "Task summary: Needs manual follow-up."],
      ["OpenClaw runtime context (internal):", "Internal task completion event"],
    );
  });
});

describe("subagents log", () => {
  function makeRun(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
    const { execution = { status: "running", startedAt: Date.now() - 10_000 }, ...record } =
      overrides;
    return commandRun({
      runId: "run-subagent-log",
      childSessionKey: "agent:main:subagent:log",
      task: "inspect logs",
      createdAt: Date.now() - 10_000,
      ...record,
      execution,
    });
  }

  function buildLogContext(
    restTokens: string[],
    runs: SubagentRunRecord[],
  ): Parameters<typeof handleSubagentsLogAction>[0] {
    return {
      params: buildCommandTestParams("/subagents log", {}),
      requesterKey: "agent:main:main",
      readContext: commandReadContext(runs),
      restTokens,
    };
  }

  beforeEach(() => {
    callGatewayMock.mockReset();
    callGatewayMock.mockResolvedValue({
      messages: [{ role: "assistant", content: "log line" }],
    });
  });

  it.each([
    {
      name: "preserves user tool markers",
      messages: [{ role: "user", content: "Here [Tool Call: foo (ID: 1)] ok" }],
      expectedText: "User: Here [Tool Call: foo (ID: 1)] ok",
      unexpectedText: "Assistant:",
    },
    {
      name: "hides signed commentary while retaining the final answer",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "PRIVATE_COMMENTARY",
              textSignature: JSON.stringify({ v: 1, phase: "commentary" }),
            },
            {
              type: "output_text",
              text: "Visible final answer",
              textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
            },
          ],
        },
      ],
      expectedText: "Assistant: Visible final answer",
      unexpectedText: "PRIVATE_COMMENTARY",
    },
    {
      name: "omits commentary-only history messages",
      messages: [{ role: "assistant", phase: "commentary", content: "PRIVATE_COMMENTARY" }],
      expectedText: "(no messages)",
      unexpectedText: "PRIVATE_COMMENTARY",
    },
    {
      name: "does not revive legacy text when the signed final answer is empty",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "PRIVATE_LEGACY" },
            {
              type: "text",
              text: "   ",
              textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
            },
          ],
        },
      ],
      expectedText: "(no messages)",
      unexpectedText: "PRIVATE_LEGACY",
    },
  ])("$name", async ({ messages, expectedText, unexpectedText }) => {
    callGatewayMock.mockResolvedValue({ messages });

    const result = await handleSubagentsLogAction(buildLogContext(["1"], [makeRun()]));
    const text = requireReplyText(result.reply);

    expect(text).toContain(expectedText);
    expect(text).not.toContain(unexpectedText);
  });

  it("uses the numeric token after the target as the history limit", async () => {
    await handleSubagentsLogAction(buildLogContext(["1", "5"], [makeRun()]));

    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey: "agent:main:subagent:log", limit: 5 },
    });
  });
});
