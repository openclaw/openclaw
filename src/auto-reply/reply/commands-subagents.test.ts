import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  configureMockSubagentRegistryPersistence,
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "../../agents/subagent-test-fixtures.test-helpers.js";
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
import { expectText } from "../../test-utils/text-assertions.js";
import { buildSubagentsStatusLine } from "./commands-status-subagents.js";
import { handleSubagentsCommand } from "./commands-subagents.js";
import { handleSubagentsInfoAction } from "./commands-subagents/action-info.js";
import { handleSubagentsListAction } from "./commands-subagents/action-list.js";
import { handleSubagentsLogAction } from "./commands-subagents/action-log.js";
import type { CommandHandlerResult } from "./commands-types.js";
import { baseCommandTestConfig, buildCommandTestParams } from "./commands.test-harness.js";

const callGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/call.js", () => ({
  callGateway: (params: unknown) => callGatewayMock(params),
}));

async function replyText(
  result: Promise<CommandHandlerResult | null | undefined>,
): Promise<string> {
  return expectDefined((await result)?.reply?.text, "expected reply text");
}

function commandRun(fields: SubagentRunRecordOverrides): SubagentRunRecord {
  return createSubagentRunRecord({
    childSessionKey: `agent:main:subagent:${fields.runId}`,
    task: "worker",
    ...fields,
  });
}

function seedRun(fields: SubagentRunRecordOverrides) {
  seedSubagentRunForReadTest(commandRun(fields));
}

function timedRun(
  runId: string,
  task: string,
  at: number,
  fields: Omit<SubagentRunRecordOverrides, "runId"> = {},
) {
  return commandRun({ runId, task, createdAt: at, startedAt: at, ...fields });
}

async function statusText(now: number, verboseEnabled = true) {
  const context = await controlScope.buildControlledSubagentRunsReadContext("agent:main:main");
  using _ = vi.spyOn(Date, "now").mockReturnValueOnce(now);
  return buildSubagentsStatusLine({ context, verboseEnabled }) ?? "";
}

async function runCommand(command: string, cfg = baseCommandTestConfig) {
  return handleSubagentsCommand(buildCommandTestParams(command, cfg), true);
}

function commandReadContext(runs: SubagentRunRecord[]) {
  const snapshot = new Map(runs.map((run) => [run.runId, run]));
  const index = buildSubagentRunReadIndexFromRuns({ runs: snapshot });
  return { list: captureSubagentListReadContext(runs, index, snapshot, 30) };
}

afterEach(async () => {
  await resetSubagentRegistryForTests({ persist: false });
  clearRuntimeConfigSnapshot();
});

beforeEach(async () => {
  await resetSubagentRegistryForTests({ persist: false });
  setRuntimeConfigSnapshot(baseCommandTestConfig);
});

describe("subagents status", () => {
  it("preserves verbose done-only summary", async () => {
    seedRun({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:done-a",
      task: "finished task",
      createdAt: 1000,
      startedAt: 1000,
      endedAt: 2000,
      outcome: { status: "ok" },
    });
    const text = await statusText(5000);
    expectText(text, ["🤖 Subagents: 0 active · 1 done"], ["  • finished task"]);
  });

  it("keeps the newest three details, pending children, and non-finite duration in the full counts", async () => {
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
      seedRun({
        runId: name,
        task: `${name} worker`,
        createdAt: now - ageMs,
        startedAt: now - ageMs,
        endedAt: ended ? now - 500 : undefined,
        ...(name === "first"
          ? {
              execution: { status: "running", startedAt: now - ageMs, endedAt: Infinity },
            }
          : {}),
      });
    }
    for (let index = 0; index < children; index++) {
      seedRun({
        runId: `child-${index}`,
        childSessionKey: `${parentKey}:subagent:${index}`,
        requesterSessionKey: parentKey,
        requesterDisplayKey: "tie-a",
        task: "pending child",
        createdAt: now - 1_000,
        startedAt: now - 1_000,
        endedAt: index > 0 ? now - 500 : undefined,
      });
    }

    const text = await statusText(now, false);
    const details = text?.split("\n").slice(1);

    expect(text).toContain("Subagents: 4 active · 1 done");
    expect(details).toEqual([
      expect.stringMatching(/first worker.*0s/),
      expect.stringMatching(/tie-b worker.*2s/),
      expect.stringMatching(new RegExp(`tie-a worker.*2s.*\\b${children} child`)),
    ]);
  });
});

describe("subagents command snapshots", () => {
  beforeEach(async () => {
    await configureMockSubagentRegistryPersistence({ persistRegistryRows: () => {} });
  });

  it("renders the captured controlled run and descendant facts after a concurrent settlement", async () => {
    const parent = commandRun({
      runId: "paired-parent",
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
    using _ = vi
      .spyOn(controlScope, "buildControlledSubagentRunsReadContext")
      .mockImplementation(async (...args) => {
        const context = await prepare(...args);
        await mutateSubagentRuns([parent.runId, child.runId], (rows) => {
          const currentParent = expectDefined(rows.get(parent.runId), "captured parent");
          const currentChild = expectDefined(rows.get(child.runId), "captured child");
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
    const text = await replyText(runCommand("/subagents list"));
    expectText(
      text,
      ["active (waiting on 1 child)", "paired parent"],
      ["changed after preparation"],
    );
  });

  it("captures controlled runs after lazy action loading", async () => {
    const controllerSessionKey = "agent:main:main";
    const parentSessionKey = "agent:main:subagent:snapshot-parent";
    const parentRunId = "snapshot-parent-run";

    await runCommand("/subagents list");
    seedRun({
      runId: parentRunId,
      childSessionKey: parentSessionKey,
      childSessionIdentity: { sessionId: "snapshot-parent-session" },
      controllerSessionKey,
      requesterSessionKey: controllerSessionKey,
      task: "removed parent",
      createdAt: Date.now() - 2_000,
      startedAt: Date.now() - 2_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
    });

    const prepare = controlScope.buildControlledSubagentRunsReadContext;
    using _ = vi
      .spyOn(controlScope, "buildControlledSubagentRunsReadContext")
      .mockImplementationOnce(async (...args) => {
        await releaseSubagentRun(parentRunId);
        await addSubagentRunForTests(
          commandRun({
            runId: "snapshot-child-run",
            childSessionKey: `${parentSessionKey}:subagent:child`,
            controllerSessionKey: parentSessionKey,
            requesterSessionKey: parentSessionKey,
            requesterDisplayKey: parentSessionKey,
            task: "new child",
            createdAt: Date.now(),
            startedAt: Date.now(),
          }),
        );
        return prepare(...args);
      });
    const text = await replyText(runCommand("/agents"));
    expectText(text, ["(none)"], ["removed parent", "waiting on 1 child"]);
  });
});

describe("subagents global-session inspection", () => {
  const privateHistory = [
    { role: "assistant", content: "PRIVATE_COMMENTARY", phase: "commentary" },
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
  ];
  const cfg: OpenClawConfig = {
    ...baseCommandTestConfig,
    agents: { ownership: "explicit", entries: { research: {}, ops: {} } },
    session: { scope: "global" },
  };

  beforeEach(async () => {
    setRuntimeConfigSnapshot(cfg);
    callGatewayMock.mockReset().mockResolvedValue({
      messages: [
        { role: "user", content: "Here [Tool Call: foo (ID: 1)] ok" },
        { role: "assistant", content: "log line" },
        ...privateHistory,
      ],
    });
    for (const agentId of ["research", "ops"]) {
      seedRun({
        runId: `global-${agentId}`,
        childSessionKey: `agent:${agentId}:subagent:worker`,
        controllerSessionKey: "global",
        requesterSessionKey: "global",
        requesterAgentId: agentId,
        requesterDisplayKey: "global",
        task: `${agentId} worker`,
        createdAt: Date.now() - 1_000,
        startedAt: Date.now() - 1_000,
      });
    }
  });

  it.each(["/subagents info 1", "/subagents log 1 5", "/agents"])(
    "keeps the selected agent's global children visible through %s",
    async (command) => {
      const params = buildCommandTestParams(command, cfg, { SessionKey: "global" });
      params.sessionKey = "global";
      params.agentId = "research";

      const text = await replyText(handleSubagentsCommand(params, true));

      expectText(text, ["research worker"], ["ops worker"]);
      if (command === "/subagents log 1 5") {
        expectText(
          text,
          ["User: Here [Tool Call: foo (ID: 1)] ok", "Assistant: log line"],
          ["Assistant: Here [Tool Call: foo (ID: 1)] ok", "PRIVATE_COMMENTARY", "PRIVATE_LEGACY"],
        );
        expect(callGatewayMock).toHaveBeenCalledWith({
          method: "chat.history",
          params: { sessionKey: "agent:research:subagent:worker", limit: 5 },
        });
        callGatewayMock.mockResolvedValue({ messages: privateHistory });
        expectText(
          await replyText(handleSubagentsCommand(params, true)),
          ["(no messages)"],
          ["PRIVATE_COMMENTARY", "PRIVATE_LEGACY"],
        );
      }
    },
  );
});

describe("subagents info", () => {
  const infoConfig: OpenClawConfig = {
    ...baseCommandTestConfig,
    session: {
      ...baseCommandTestConfig.session,
      store: path.join(os.tmpdir(), `openclaw-commands-subagents-info-${process.pid}.json`),
    },
  };

  function buildInfoContext(
    records: SubagentRunRecord[],
    restTokens = ["1"],
    config = infoConfig,
  ): Parameters<typeof handleSubagentsInfoAction>[0] {
    const runs = records.map(({ runId }) => {
      const run = subagentRuns.get(runId);
      if (!run) {
        throw new Error(`Info fixture has no registered run: ${runId}`);
      }
      return run;
    });
    return {
      params: buildCommandTestParams("/subagents info", config),
      requesterKey: "agent:main:main",
      readContext: commandReadContext(runs),
      restTokens,
    };
  }

  async function inspectRun(run: SubagentRunRecord, cfg?: OpenClawConfig, target = "1") {
    seedSubagentRunForReadTest(run);
    const result = await handleSubagentsInfoAction(buildInfoContext([run], [target], cfg));
    expect(result.shouldContinue).toBe(false);
    return expectDefined(result.reply?.text, "expected reply text");
  }

  beforeEach(() => setRuntimeConfigSnapshot(infoConfig));

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
      const run = timedRun("research-info", "Inspect the recorded child", Date.now(), {
        childSessionKey: "global",
        childAgentId: "research",
      });
      const text = await inspectRun(run, cfg, run.runId);
      expectText(text, ["SessionId: research-session"], ["SessionId: main-session"]);
    });
  });

  it("refuses info after its selected run changes controllers during the child read", async () => {
    const run = timedRun("held-info-run", "Inspect the original child", Date.now(), {
      childSessionKey: "agent:main:subagent:held-info",
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
    const result = handleSubagentsInfoAction(buildInfoContext([run], [run.runId]));
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
    const result = await handleSubagentsInfoAction(buildInfoContext([], []));
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("/subagents info <id|#>");
  });

  it("returns info for a subagent with discard reason=expired", async () => {
    const now = Date.now();
    const runId = "info-discard";
    const run = timedRun(runId, "do thing", now - 20_000, {
      endedAt: now - 8 * 24 * 60 * 60_000,
      outcome: { status: "ok" },
      completion: { required: true, resultText: "Completed the requested task" },
    });
    run.delivery = {
      status: "suspended",
      suspendedAt: now - 7 * 24 * 60 * 60_000,
      suspendedReason: "permanent_failure",
      lastError: "requester unavailable\ntry retained result",
    };
    SubagentLifecycleController.discardTerminalDelivery(run, now);
    expect(run.delivery.lastError).toBeUndefined();
    const text = await inspectRun(run, undefined, run.runId);
    expectText(text, [
      "Status: done",
      "Outcome: ok",
      "Progress: Completed the requested task",
      "Delivery: discarded",
      "Delivery disposition: expired",
      `Delivery retired: ${new Date(now).toISOString()}`,
      "Task summary: requester unavailable try retained result",
    ]);
  });

  it("uses displayed indices and killed status for info and log beside stale unended runs", async () => {
    const now = Date.now();
    const runs: SubagentRunRecord[] = [
      timedRun("numbering-stale", "stale worker", now - 3 * 60 * 60_000),
      timedRun("numbering-recent", "recent worker", now - 120_000, {
        endedAt: now - 60_000,
        endedReason: SUBAGENT_ENDED_REASON_KILLED,
        outcome: { status: "error", error: "agent run aborted" },
      }),
    ];
    for (const run of runs) {
      seedSubagentRunForReadTest(run);
    }
    const context = buildInfoContext(runs);
    const listing = await replyText(handleSubagentsListAction(context));
    expectText(listing, ["1. recent worker", " killed"], ["stale worker"]);
    expectText(await replyText(handleSubagentsInfoAction(context)), [
      "Run: numbering-recent",
      "Status: killed",
    ]);
    callGatewayMock.mockResolvedValue({ messages: [] });
    await handleSubagentsLogAction(context);
    expect(callGatewayMock).toHaveBeenLastCalledWith({
      method: "chat.history",
      params: { sessionKey: "agent:main:subagent:numbering-recent", limit: 20 },
    });
  });

  it("omits Date-invalid subagent timestamps", async () => {
    const runId = "invalid-date";
    const invalidDate = 8_640_000_000_000_001;
    const run = timedRun(runId, "inspect invalid timestamps", invalidDate, {
      endedAt: invalidDate,
      outcome: { status: "ok" },
      archiveAtMs: invalidDate,
    });
    const text = await inspectRun(run);
    expectText(
      text,
      [`Run: ${runId}`, "Created: n/a", "Started: n/a", "Ended: n/a", "Archive: n/a"],
      ["Invalid Date"],
    );
  });

  it("sanitizes leaked task details in /subagents info", async () => {
    const now = Date.now();
    const run = timedRun("info-leak", "Inspect the stuck run", now - 20_000, {
      endedAt: now - 1_000,
      delivery: { status: "suspended", lastError: "Needs manual follow-up." },
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
    });
    const text = await inspectRun(run);
    expectText(
      text,
      ["Subagent info", "Outcome: error", "Task summary: Needs manual follow-up."],
      ["OpenClaw runtime context (internal):", "Internal task completion event"],
    );
  });
});

describe("subagents log", () => {
  function signedText(text: string, phase: string, type = "text") {
    return { type, text, textSignature: JSON.stringify({ v: 1, phase }) };
  }

  function assistant(content: unknown, phase?: string) {
    return { role: "assistant", content, ...(phase ? { phase } : {}) };
  }

  function logContext(restTokens = ["1"]): Parameters<typeof handleSubagentsLogAction>[0] {
    return {
      params: buildCommandTestParams("/subagents log", {}),
      requesterKey: "agent:main:main",
      readContext: commandReadContext([
        timedRun("run-subagent-log", "inspect logs", Date.now() - 10_000, {
          childSessionKey: "agent:main:subagent:log",
        }),
      ]),
      restTokens,
    };
  }

  beforeEach(() => {
    callGatewayMock.mockReset().mockResolvedValue({ messages: [assistant("log line")] });
  });

  it.each<[name: string, message: unknown, expected: string, excluded: string]>([
    [
      "preserves user tool markers",
      { role: "user", content: "Here [Tool Call: foo (ID: 1)] ok" },
      "User: Here [Tool Call: foo (ID: 1)] ok",
      "Assistant:",
    ],
    [
      "hides signed commentary, keeps final answer",
      assistant([
        signedText("PRIVATE_COMMENTARY", "commentary"),
        signedText("Visible final answer", "final_answer", "output_text"),
      ]),
      "Assistant: Visible final answer",
      "PRIVATE_COMMENTARY",
    ],
    [
      "omits commentary-only history messages",
      assistant("PRIVATE_COMMENTARY", "commentary"),
      "(no messages)",
      "PRIVATE_COMMENTARY",
    ],
    [
      "empty signed final hides legacy text",
      assistant([{ type: "text", text: "PRIVATE_LEGACY" }, signedText("   ", "final_answer")]),
      "(no messages)",
      "PRIVATE_LEGACY",
    ],
  ])("%s", async (_name, message, expectedText, unexpectedText) => {
    callGatewayMock.mockResolvedValue({ messages: [message] });

    const text = await replyText(handleSubagentsLogAction(logContext()));

    expectText(text, [expectedText], [unexpectedText]);
  });

  it("uses the numeric token after the target as the history limit", async () => {
    await handleSubagentsLogAction(logContext(["1", "5"]));

    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey: "agent:main:subagent:log", limit: 5 },
    });
  });
});
