import "../../src/test-utils/prepare-compiled-subprocesses.js";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  createCliTestHarness,
  executeClaudeCli,
  prepareClaudeNativeGoal,
  waitForProcessExit,
} from "../../extensions/anthropic/test-api.js";
import {
  prepareSystemAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../../src/agents/admitted-run-context.js";
import { testing as cliBackendsTesting } from "../../src/agents/cli-backends.test-support.js";
import { buildDefaultTestCliBackend } from "../../src/agents/cli-runner.test-helpers.js";
import {
  runPlugin,
  SUCCESS_RESULT,
} from "../../src/agents/cli-runner/execute-plugin.test-support.js";
import { setRawCliBackendForPrepareTest } from "../../src/agents/cli-runner/prepare-mcp.test-support.js";
import { prepareCliRunContext } from "../../src/agents/cli-runner/prepare.js";
import * as preparation from "../../src/agents/cli-runner/prepare.test-support.js";
import type { PreparedCliRunContext } from "../../src/agents/cli-runner/types.js";
import { setRuntimeConfigSnapshot } from "../../src/config/runtime-snapshot.js";
import {
  createSessionGoal,
  updateSessionGoalObjective,
  updateSessionGoalStatus,
} from "../../src/config/sessions/goals.js";
import { resolveSessionStorePathCore } from "../../src/config/sessions/paths.js";
import {
  loadExactSessionEntry,
  replaceSessionEntry,
  updateSessionEntry,
} from "../../src/config/sessions/session-accessor.js";
import * as replacements from "../../src/config/sessions/session-accessor.sqlite-replacement-worker.js";
import { reduceSessionBookkeeping } from "../../src/config/sessions/session-entry-patch-operation.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../../src/config/sessions/types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "../../src/gateway/mcp-http.js";
import {
  connectPreparedCliTurn,
  setMinimalCliPrepareDeps,
} from "../../src/gateway/mcp-http.test-support.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../src/plugins/runtime.js";
import { openOpenClawStateDatabase } from "../../src/state/openclaw-state-db.js";
import * as testState from "../../src/test-utils/openclaw-test-state.js";

let state: testState.OpenClawTestState;
let config: OpenClawConfig;
const contexts: PreparedCliRunContext[] = [];
const admissions: PreparedAgentRunAdmission[] = [];
const objective = "Verify the checked deliverable";

beforeAll(async () => {
  state = await testState.createOpenClawTestState({
    prefix: "openclaw-claude-goal-mcp-",
    layout: "state-only",
    env: { OPENCLAW_TEST_FAST: "0", OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  config = {
    agents: {
      defaults: {
        workspace: state.workspaceDir,
        skipBootstrap: true,
        model: { primary: "claude-cli/sonnet" },
      },
      entries: { main: { workspace: state.workspaceDir } },
    },
    plugins: { enabled: false },
    skills: { load: { watch: false } },
    tools: { allow: ["get_goal", "update_goal"], codeMode: false, toolSearch: false },
  };
  await state.writeConfig(config);
  setRuntimeConfigSnapshot(config);
  openOpenClawStateDatabase();
  setActivePluginRegistry(createEmptyPluginRegistry());
  setRawCliBackendForPrepareTest({
    ...buildDefaultTestCliBackend({ bundleMcp: true }),
    id: "claude-cli",
    autoSelectAuthProfile: false,
    nativeToolMode: "selectable",
    toolAvailabilityEnforcement: "execution-args",
    resolveExecutionArgs: ({ baseArgs }) => baseArgs,
  });
  setMinimalCliPrepareDeps(preparation.setCliRunnerPrepareTestDeps);
  await ensureMcpLoopbackServer();
});

afterAll(async () => {
  for (const context of contexts) {
    await context.preparedBackend.cleanup?.();
  }
  admissions.forEach((admission) => admission.close());
  await closeMcpLoopbackServer();
  preparation.resetCliRunnerPrepareTestDeps();
  cliBackendsTesting.resetDepsForTest();
  await state?.cleanup();
});

it.for([
  "loop-complete",
  "loop-blocked",
  "loop-stop",
  "loop-pause",
  "loop-edit",
  "complete",
  "blocked",
  "pause-before",
  "foreign-run",
  "stop-after",
  "edit-after",
  "verdict-edit-after",
  "grant-before-commit",
] as const)(
  "settles ordinary Claude MCP Goal tools under exact native ownership: %s",
  async (scenario, { signal }) => {
    const sessionId = `goal-mcp-${scenario}`;
    const target = {
      agentId: "main",
      sessionKey: `agent:main:${sessionId}`,
      sessionId,
      storePath: resolveSessionStorePathCore(config.session?.store, { agentId: "main" }),
    };
    const entry = {
      sessionId,
      lifecycleRevision: "original",
      updatedAt: Date.now(),
      sessionStartedAt: Date.now(),
      permissionMode: "full" as const,
      totalTokens: 10,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
    };
    await replaceSessionEntry(target, entry);
    await createSessionGoal({ ...target, objective });
    const read = () => loadExactSessionEntry(target)!.entry;
    const prepare = async (suffix: string) => {
      const runId = `${sessionId}-${suffix}`;
      const admission = prepareSystemAgentRunAdmission(config, runId, "main", "goal-mcp-test");
      admissions.push(admission);
      const context = await prepareCliRunContext({
        preparedRunAdmission: admission,
        config,
        ...target,
        sessionEntry: read(),
        sessionTarget: target,
        expectedLifecycleRevision: entry.lifecycleRevision,
        sessionFile: state.path(`${sessionId}.jsonl`),
        workspaceDir: state.workspaceDir,
        cwd: state.workspaceDir,
        provider: "claude-cli",
        model: "sonnet",
        modelHasVision: false,
        prompt: "Continue the work and give the final response.",
        skillsSnapshot: { prompt: "", skills: [] },
        senderIsOwner: true,
        toolsAllow: ["get_goal", "update_goal"],
        runId,
        timeoutMs: 60_000,
        abortSignal: signal,
      });
      contexts.push(context);
      return context;
    };
    const context = await prepare("owner");
    const foreign = scenario === "foreign-run" ? await prepare("foreign") : undefined;
    if (scenario.startsWith("loop-")) {
      const harness = createCliTestHarness("openclaw-goal-stop-mcp-");
      const records: Record<string, unknown>[] = [];
      let pid: number | undefined;
      let successors = 0;
      let commits = 0;
      let accounted: ReturnType<typeof read>["goal"];
      const revoked = !["loop-complete", "loop-blocked"].includes(scenario);
      try {
        const result = runPlugin(
          context,
          async function* (execution) {
            const peer = await harness.context(stopFixture);
            const fixture: typeof execution = {
              ...peer,
              ...execution,
              args: peer.args,
              // Only the native peer is synthetic; the run, Goal owner, RPC grant,
              // durable transaction, output reader and cleanup are production paths.
              command: process.execPath,
              requestToolPermission: async ({
                toolName,
                toolInput,
              }: Parameters<typeof execution.requestToolPermission>[0]) => {
                if (toolName === "Read") {
                  successors++;
                  return { behavior: "allow", updatedInput: toolInput };
                }
                expect(toolName).toBe("mcp__openclaw__update_goal");
                const { rpc } = await connectPreparedCliTurn(context, signal);
                const status = ["loop-blocked", "loop-pause", "loop-edit"].includes(scenario)
                  ? "blocked"
                  : "complete";
                const response = await rpc("tools/call", {
                  name: "update_goal",
                  arguments: { status, note: "Checked terminal verdict" },
                });
                expect(response).toMatchObject({
                  status: 200,
                  body: { result: { isError: false } },
                });
                commits++;
                expect(read().goal?.status).toBe(status);
                await updateSessionEntry(target, (currentEntry) =>
                  reduceSessionBookkeeping(currentEntry, {
                    kind: "usage",
                    updatedAt: Date.now(),
                    update: {
                      modelSelection: { provider: "claude-cli", model: "sonnet" },
                      hasContextUpdate: true,
                      hasFreshContextSnapshot: true,
                      hasCurrentContextSnapshot: true,
                      currentContextTokens: 40,
                      preserveSessionModelState: true,
                      preserveUserFacingRunState: false,
                    },
                  }),
                );
                accounted = read().goal;
                expect(accounted?.tokensUsed).toBe(30);
                if (scenario === "loop-stop") {
                  await updateSessionEntry(target, () => ({ abortedLastRun: true }));
                } else if (scenario === "loop-pause") {
                  await updateSessionGoalStatus({ ...target, status: "paused" });
                } else if (scenario === "loop-edit") {
                  await updateSessionGoalObjective({
                    ...target,
                    objective: "Replacement objective",
                  });
                }
                return { behavior: "allow", updatedInput: toolInput };
              },
            };
            for await (const row of executeClaudeCli(fixture)) {
              if (row.subtype === "fixture_ready") {
                pid = Number(row.pid);
              }
              yield row;
            }
          },
          {
            sessionId,
            consumeStdout: (line) => records.push(JSON.parse(line)),
            noOutputTimeoutMs: 60_000,
          },
        );
        if (revoked) {
          await expect(result).rejects.toThrow();
          if (scenario === "loop-pause") {
            expect(read().goal?.status).toBe("paused");
          } else if (scenario === "loop-edit") {
            expect(read().goal?.objective).toBe("Replacement objective");
          } else {
            expect(read().abortedLastRun).toBe(true);
          }
          expect(records.filter((row) => row.type === "result")).toEqual([]);
        } else {
          await expect(result).resolves.toMatchObject({ reason: "exit", exitCode: 0 });
          expect(records.filter((row) => row.type === "result")).toEqual([
            {
              type: "result",
              subtype: "success",
              is_error: false,
              result: "Checked final response.",
              session_id: sessionId,
            },
          ]);
          expect(read().goal).toEqual(accounted);
        }
        expect(commits).toBe(1);
        expect(successors).toBe(0);
        expect(pid).toEqual(expect.any(Number));
        await waitForProcessExit([pid!], signal);
      } finally {
        await harness.cleanup();
      }
      return;
    }
    const output: string[] = [];
    let native: Awaited<ReturnType<typeof prepareClaudeNativeGoal>>;
    let completed = false;
    let call: Awaited<ReturnType<typeof connectPreparedCliTurn>>["rpc"] | undefined;
    // Only inference is synthetic. CLI admission/lifetime, HTTP grant/tool execution,
    // host Goal transaction/publication, Claude preparation and final settlement are real.
    const result = runPlugin(
      context,
      async function* (execution) {
        native = await prepareClaudeNativeGoal(execution);
        if (!native) {
          throw new Error("Ordinary CLI native owner missing");
        }
        expect(native.input).toBe(`/goal ${objective}`);
        expect(native.signal.aborted).toBe(false);
        const { rpc } = await connectPreparedCliTurn(foreign ?? context, signal);
        call = rpc;
        const catalog = await rpc("tools/list");
        expect(catalog.body.result?.tools?.map((tool) => tool.name)).toContain("update_goal");
        if (scenario === "pause-before") {
          await updateSessionGoalStatus({ ...target, status: "paused", note: "Operator paused" });
        }
        const status = scenario === "blocked" || scenario === "edit-after" ? "blocked" : "complete";
        // Revoke the actual capture after the real Goal transaction prepared its
        // postimage, before the real worker's admission/commit. No writer is replaced.
        const commit = replacements.commitSessionEntryReplacementsInWorker;
        const revoke =
          scenario === "grant-before-commit"
            ? vi
                .spyOn(replacements, "commitSessionEntryReplacementsInWorker")
                .mockImplementationOnce(async (...args) => {
                  context.preparedBackend.mcpClientGrantCapture!.deactivate(
                    `capture-${context.params.runId}`,
                  );
                  return await commit(...args);
                })
            : undefined;
        const response = await rpc("tools/call", {
          name: "update_goal",
          arguments: { status, note: "Verified by the admitted tool" },
        }).finally(() => revoke?.mockRestore());
        if (scenario === "grant-before-commit") {
          expect(response.body.result?.isError).toBe(true);
          expect(read().goal?.status).toBe("active");
        } else if (scenario === "pause-before") {
          expect(response.status === 401 || response.body.result?.isError === true).toBe(true);
          expect(read().goal?.status).toBe("paused");
        } else {
          expect(response).toMatchObject({ status: 200, body: { result: { isError: false } } });
          expect(JSON.parse(response.body.result!.content![0]!.text!)).toMatchObject({
            status: "updated",
            goal: { status },
          });
          expect(read().goal?.status).toBe(status);
          if (scenario !== "foreign-run") {
            expect(native.signal.aborted).toBe(false);
          }
        }
        const committed = read().goal;
        if (scenario === "stop-after") {
          await updateSessionEntry(target, () => ({ abortedLastRun: true }));
        }
        if (scenario === "edit-after") {
          await updateSessionGoalObjective({ ...target, objective: "New operator objective" });
        }
        if (scenario === "verdict-edit-after") {
          await updateSessionGoalStatus({
            ...target,
            status: "complete",
            note: "New operator verdict",
          });
        }
        if (scenario !== "complete" && scenario !== "blocked") {
          expect(native.signal.aborted).toBe(true);
          const beforeFinish = read();
          await expect(native.finish(SUCCESS_RESULT)).rejects.toThrow();
          expect(read()).toEqual(beforeFinish);
          throw new Error("Native result revoked");
        }
        // The same owner remains valid through final accounting, including the
        // continuation counter used by required recovery before event settlement.
        await updateSessionEntry(target, (currentEntry) =>
          reduceSessionBookkeeping(currentEntry, {
            kind: "usage",
            updatedAt: Date.now(),
            update: {
              modelSelection: { provider: "claude-cli", model: "sonnet" },
              hasContextUpdate: true,
              hasFreshContextSnapshot: true,
              hasCurrentContextSnapshot: true,
              currentContextTokens: 40,
              preserveSessionModelState: true,
              preserveUserFacingRunState: false,
            },
          }),
        );
        await updateSessionEntry(target, (currentEntry) =>
          reduceSessionBookkeeping(currentEntry, {
            kind: "goal-continuation",
            goalId: committed!.id,
          }),
        );
        const accounted = { ...committed, tokensUsed: 30, continuationTurns: 1 };
        expect(read().goal).toEqual(accounted);
        expect(native.signal.aborted).toBe(false);
        if (scenario === "blocked") {
          // A stale native success cannot replace the tool's committed blocked verdict.
          native.observe({
            type: "transcript_mirror",
            entries: [
              {
                sessionId,
                type: "attachment",
                attachment: { type: "goal_status", condition: objective, met: true },
              },
            ],
          });
        }
        // Complete deliberately has no mirror: the real tool is already the verdict owner.
        await native.finish(SUCCESS_RESULT);
        expect(read().goal).toEqual(accounted);
        expect(native.signal.aborted).toBe(false);
        completed = true;
        yield { ...SUCCESS_RESULT, session_id: sessionId, result: "Checked final response." };
      },
      { sessionId, consumeStdout: (chunk) => output.push(chunk), noOutputTimeoutMs: 60_000 },
    );
    if (scenario === "complete" || scenario === "blocked") {
      await expect(result).resolves.toMatchObject({ reason: "exit", exitCode: 0 });
      expect(completed).toBe(true);
      expect(output.map((line) => JSON.parse(line))).toEqual([
        { ...SUCCESS_RESULT, session_id: sessionId, result: "Checked final response." },
      ]);
      expect(read().goal?.status).toBe(scenario);
      const committed = read().goal;
      // The MCP grant drains after native callback closure. It cannot fall back
      // to an unowned status write in that interval.
      const late = await call!("tools/call", {
        name: "update_goal",
        arguments: { status: "blocked", note: "late" },
      });
      expect(late.body.result?.isError).toBe(true);
      expect(read().goal).toEqual(committed);
    } else {
      await expect(result).rejects.toThrow("Native result revoked");
      expect(completed).toBe(false);
      expect(output).toEqual([]);
    }
    expect(native!.signal.aborted).toBe(true);
    await expect(native!.finish(SUCCESS_RESULT)).rejects.toThrow();
  },
);

// Native 2.1.318: Stop continue:false takes precedence over prompt-hook
// blocking errors. With no registered Stop hook the unmet verdict pursues again.
const stopFixture = String.raw`
import { createInterface } from "node:readline";
const send = row => process.stdout.write(JSON.stringify(row) + "\n");
let hook, sessionId;
const finish = () => send({type:"result",subtype:"success",is_error:false,result:"Checked final response.",session_id:sessionId});
const successor = () => send({type:"control_request",request_id:"successor",request:{subtype:"can_use_tool",tool_name:"Read",input:{file_path:"successor-effect"}}});
const commit = () => send({type:"control_request",request_id:"commit",request:{subtype:"can_use_tool",tool_name:"mcp__openclaw__update_goal",input:{}}});
const stop = id => send({type:"control_request",request_id:id,request:{subtype:"hook_callback",callback_id:hook,input:{hook_event_name:"Stop",stop_hook_active:false,session_id:sessionId}}});
for await (const line of createInterface({input:process.stdin})) {
  const row = JSON.parse(line);
  if (row.type === "control_request") {
    hook = row.request.hooks?.Stop?.[0]?.hookCallbackIds?.[0];
    send({type:"control_response",response:{subtype:"success",request_id:row.request_id,response:{claude_code_version:"2.1.318"}}});
  } else if (row.type === "user") {
    sessionId = row.session_id;
    send({type:"system",subtype:"fixture_ready",pid:process.pid});
    if (hook) stop("before"); else commit();
  } else if (row.type === "control_response") {
    const id = row.response.request_id, answer = row.response.response;
    if (id === "before") {
      if (answer?.continue === false) finish(); else commit();
    } else if (id === "commit") {
      if (answer?.behavior !== "allow") continue;
      send({type:"assistant",message:{role:"assistant",content:[{type:"text",text:"Checked final response."}]}});
      send({type:"transcript_mirror",entries:[{type:"attachment",sessionId,attachment:{type:"goal_status",condition:"Verify the checked deliverable",met:false,reason:"not_met"}}]});
      if (hook) stop("after"); else successor();
    } else if (id === "after") {
      if (answer?.continue === false) finish(); else successor();
    } else if (id === "successor") finish();
  }
}
`;
