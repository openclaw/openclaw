import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { StreamFn } from "../agents/runtime/index.js";
import { SessionFollowupCompletion } from "../agents/subagents/completion/session-followup-completion.js";
import { getSubagentRunByRunId } from "../agents/subagents/registry/subagent-registry.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import type { AssistantMessage } from "../llm/types.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewayConfigPath,
  setupGatewayTempHome,
  removeGatewayTempHome,
} from "./gateway.test-support.js";
import type { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import { startGatewayWithClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

// Only inference is synthetic. All tools, caller custody, Gateway admission, SQL and
// publication execute normally; pass-through barriers select the failing order.
const fixture = vi.hoisted(() => ({
  stream: undefined as StreamFn | undefined,
  beforeSettle: undefined as ((runId: string) => Promise<void>) | undefined,
  afterResult: undefined as ((command: unknown) => Promise<void>) | undefined,
  beforeLifecycle: undefined as
    | ((params: Parameters<typeof persistGatewaySessionLifecycleEvent>[0]) => Promise<void>)
    | undefined,
}));
vi.mock("../agents/provider-stream.js", () => ({
  registerProviderStreamForModel: () => {
    if (!fixture.stream) {
      throw new Error("Synthetic inference used outside its scenario lifetime");
    }
    return fixture.stream;
  },
}));
vi.mock("../agents/assistant-error-transcript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/assistant-error-transcript.js")>();
  return {
    ...actual,
    createAssistantErrorTranscript: (
      params: Parameters<typeof actual.createAssistantErrorTranscript>[0],
    ) => {
      const owned = actual.createAssistantErrorTranscript(params);
      return {
        ...owned,
        settle: async (failed: boolean) => {
          await owned.settle(failed);
          await fixture.beforeSettle?.(params.runId);
        },
      };
    },
  };
});
vi.mock("./session-lifecycle-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-lifecycle-state.js")>();
  return {
    ...actual,
    persistGatewaySessionLifecycleEvent: async (
      params: Parameters<typeof actual.persistGatewaySessionLifecycleEvent>[0],
    ) => {
      await fixture.beforeLifecycle?.(params);
      return await actual.persistGatewaySessionLifecycleEvent(params);
    },
  };
});
vi.mock("../state/openclaw-agent-execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/openclaw-agent-execution.js")>();
  return {
    ...actual,
    captureOpenClawAgentDatabaseExecution: (
      ...args: Parameters<typeof actual.captureOpenClawAgentDatabaseExecution>
    ): ReturnType<typeof actual.captureOpenClawAgentDatabaseExecution> => {
      const owned = actual.captureOpenClawAgentDatabaseExecution(...args);
      return {
        ...owned,
        runExisting: (source, operation, options) =>
          owned.runExisting(
            source,
            (scope) =>
              operation({
                execute: async (command, commandOptions) => {
                  const result = await scope.execute(command, commandOptions);
                  await fixture.afterResult?.(command);
                  return result;
                },
              }),
            options,
          ),
      };
    },
  };
});

let home: Awaited<ReturnType<typeof setupGatewayTempHome>>;
let gateway: Awaited<ReturnType<typeof startGatewayWithClient>>;
beforeAll(async () => {
  home = await setupGatewayTempHome({ prefix: "openclaw-yield-publication-" });
  const provider = buildMockOpenAiResponsesProvider("https://yield-fixture.invalid/v1", "fixture");
  gateway = await startGatewayWithClient({
    configPath: await createGatewayConfigPath(home.tempHome),
    token: "synthetic-yield-proof-token",
    cfg: {
      logging: { level: "error", file: home.tempHome + "/gateway.log" },
      agents: {
        defaults: {
          workspace: home.workspaceDir,
          heartbeat: { every: "0m" },
          model: { primary: provider.modelRef },
          subagents: { maxSpawnDepth: 4 },
        },
        entries: { main: { default: true } },
      },
      models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
      tools: { profile: "full", toolSearch: false, codeMode: false },
      gateway: { auth: { token: "synthetic-yield-proof-token" } },
    },
  });
  await gateway.server.startupSettled;
}, 90000);
afterAll(async () => {
  try {
    if (gateway) {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: "yield publication proof complete" });
    }
  } finally {
    if (home) {
      await removeGatewayTempHome(home.tempHome);
      home.envSnapshot.restore();
    }
  }
});

it.for([
  {
    name: "completed child before yield",
    childActive: false,
    successorAccepted: false,
    delayTerminal: false,
  },
  {
    name: "active child at yield",
    childActive: true,
    successorAccepted: false,
    delayTerminal: false,
  },
  {
    name: "successor already accepted",
    childActive: false,
    successorAccepted: true,
    delayTerminal: false,
  },
  {
    name: "delayed terminal persistence",
    childActive: false,
    successorAccepted: false,
    delayTerminal: true,
  },
])(
  "preserves exactly one nested followup through metadata publication: $name",
  { timeout: 30000 },
  async (scenario, { signal, onTestFinished }) => {
    const root = "agent:main:dashboard:yield-" + scenario.name.replaceAll(" ", "-");
    const metadataLabel = scenario.name + " metadata";
    const runIds = new Set<string>();
    const parked = createDeferredCore();
    const leafEnded = createDeferredCore();
    const parentYielded = createDeferredCore();
    const completed = createDeferredCore();
    const publicationEntered = createDeferredCore();
    const publicationRelease = createDeferredCore();
    const terminalEntered = createDeferredCore();
    const terminalRelease = createDeferredCore();
    let pendingPatch: Promise<unknown> | undefined;
    let parentKey: string | undefined;
    let parentStage = 0;
    let rootStage = 0;
    let toolId = 0;
    let gated = false;
    let finalCount = 0;
    let successorCount = 0;
    let delayedTerminals = 0;
    let assertAdoptedExecution: ((runId: string) => void) | undefined;
    const abortFixture = () => {
      publicationRelease.resolve();
      terminalRelease.resolve();
      parentYielded.resolve();
      parked.resolve();
      leafEnded.resolve();
      completed.reject(signal.reason);
    };
    signal.addEventListener("abort", abortFixture, { once: true });
    onTestFinished(() => signal.removeEventListener("abort", abortFixture));
    const failures: unknown[] = [];
    const parentRuns = new Set<string>();
    const stop = onAgentEvent((event) => {
      const key = event.sessionKey ?? getAgentRunContext(event.runId)?.sessionKey;
      if (event.stream !== "lifecycle") {
        return;
      }
      const requester = getSubagentRunByRunId(event.runId)?.requesterSessionKey;
      if (
        key !== root &&
        requester !== root &&
        !(parentKey && (key === parentKey || requester === parentKey))
      ) {
        return;
      }
      if (event.data.phase === "start") {
        runIds.add(event.runId);
      }
      if (key === parentKey && event.data.phase === "start") {
        parentRuns.add(event.runId);
      }
      if (event.data.phase === "error") {
        failures.push(event.data.error);
        completed.reject(new Error(String(event.data.error)));
      }
      if (event.data.phase !== "end") {
        return;
      }
      const terminal = event.data.terminalReply;
      const text = isRecord(terminal) ? terminal.text : undefined;
      if (text === "ROOT_DONE") {
        completed.resolve();
      }
      if (event.data.yielded && parentStage === 1) {
        parked.resolve();
      }
      if (event.data.yielded && parentStage === 3) {
        parentYielded.resolve();
      }
      if (text === "LEAF_DONE") {
        leafEnded.resolve();
      }
    });
    // oxlint-disable-next-line typescript/unbound-method -- The pass-through spy reapplies the actual owner below.
    const promote = SessionFollowupCompletion.prototype.promoteYield;
    const promotion = vi
      .spyOn(SessionFollowupCompletion.prototype, "promoteYield")
      .mockImplementation(function (this: SessionFollowupCompletion, ...args) {
        try {
          assertAdoptedExecution = (runId) => this.assertExecutionCurrent(runId);
          return promote.apply(this, args);
        } finally {
          if (gated && !scenario.successorAccepted) {
            publicationRelease.resolve();
          }
        }
      });
    fixture.afterResult = async (command) => {
      if (
        !isRecord(command) ||
        command.type !== "session.entries.replace" ||
        !isRecord(command.input)
      ) {
        return;
      }
      const replacements = command.input.replacements;
      if (
        Array.isArray(replacements) &&
        replacements.some(
          (row) =>
            isRecord(row) &&
            row.sessionKey === root &&
            isRecord(row.entry) &&
            row.entry.label === metadataLabel,
        )
      ) {
        publicationEntered.resolve();
        await publicationRelease.promise;
      }
    };
    fixture.beforeSettle = async (runId) => {
      if (
        gated ||
        parentStage !== (scenario.successorAccepted ? 4 : 3) ||
        getAgentRunContext(runId)?.sessionKey !== parentKey
      ) {
        return;
      }
      gated = true;
      pendingPatch = gateway.client.request("sessions.patch", {
        key: root,
        label: metadataLabel,
      });
      void pendingPatch.catch((error: unknown) => {
        publicationEntered.reject(error);
        completed.reject(error);
      });
      await publicationEntered.promise;
      if (scenario.successorAccepted) {
        try {
          // Observe the actual adopted owner, not a fabricated permission flag. Holding
          // the database writer until final settlement would block that run's own writes.
          if (!assertAdoptedExecution) {
            throw new Error("The followup never transferred its cohort");
          }
          assertAdoptedExecution(runId);
        } finally {
          publicationRelease.resolve();
        }
      }
    };
    fixture.beforeLifecycle = async (params) => {
      if (
        scenario.delayTerminal &&
        parentStage === 3 &&
        params.sessionKey === parentKey &&
        params.event.data?.yielded === true &&
        params.event.data.phase === "end"
      ) {
        delayedTerminals++;
        terminalEntered.resolve();
        await terminalRelease.promise;
      }
    };
    fixture.stream = (model, context) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const user = context.messages.findLast(
          (message) =>
            message.role === "user" &&
            !("runtimeContextCarrier" in message && message.runtimeContextCarrier),
        );
        const text = JSON.stringify(user);
        const tool = (name: string, args: Record<string, unknown>): AssistantMessage["content"] => [
          { type: "toolCall", id: "yield-tool-" + ++toolId, name, arguments: args },
        ];
        const reply = (value: string): AssistantMessage["content"] => [
          { type: "text", text: value },
        ];
        let content: AssistantMessage["content"];
        if (
          text.includes("A child is paused awaiting a continuation; this is not a completion.") ||
          text.includes("Follow the heartbeat monitor scratch context when provided.")
        ) {
          // This suite owns one provider, not background scheduling. Neither a
          // paused notice nor an unrelated heartbeat is the requested child result.
          content = reply("NO_REPLY");
        } else if (text.includes("[Subagent Task]") && text.includes("PROOF_LEAF")) {
          if (scenario.childActive) {
            await parentYielded.promise;
          }
          content = reply("LEAF_DONE");
        } else if (text.includes("PROOF_PARK") && parentStage === 0) {
          parentStage = 1;
          content = tool("sessions_yield", { waitFor: "message" });
        } else if (text.includes("PROOF_WORK") && parentStage === 1) {
          parentStage = 2;
          content = tool("sessions_spawn", {
            task: "PROOF_LEAF",
            runtime: "subagent",
            context: "isolated",
            completionTarget: "parent",
          });
        } else if (text.includes("PROOF_WORK") && parentStage === 2) {
          if (!scenario.childActive) {
            await leafEnded.promise;
          }
          parentStage = 3;
          content = tool("sessions_yield", {});
        } else if (text.includes("PROOF_ROOT") && rootStage === 0) {
          rootStage = 1;
          content = tool("sessions_spawn", {
            task: "PROOF_PARK",
            runtime: "subagent",
            context: "isolated",
            completionTarget: "parent",
          });
        } else if (text.includes("PROOF_ROOT") && rootStage === 1) {
          await parked.promise;
          parentKey = /agent:main:subagent:[a-f0-9-]+/.exec(
            JSON.stringify(context.messages.filter((message) => message.role === "toolResult")),
          )?.[0];
          expect(parentKey).toBeDefined();
          rootStage = 2;
          content = tool("sessions_send", {
            sessionKey: parentKey!,
            message: "PROOF_WORK",
            mode: "followup",
            timeoutSeconds: 0,
          });
        } else if (text.includes("PROOF_ROOT")) {
          content = reply("ROOT_WAITING");
        } else if (parentStage === 3 && text.includes("LEAF_DONE")) {
          successorCount++;
          parentStage = 4;
          content = reply("WORKER_DONE");
        } else {
          expect(text).toContain("WORKER_DONE");
          expect(parentStage).toBe(4);
          expect(rootStage).toBe(2);
          finalCount++;
          content = reply("ROOT_DONE");
        }
        const reason = content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content,
          stopReason: reason,
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        stream.push({ type: "done", reason, message });
        stream.end();
      })().catch((error: unknown) => {
        completed.reject(error);
        stream.end();
      });
      return stream;
    };
    onTestFinished(async () => {
      publicationRelease.resolve();
      terminalRelease.resolve();
      parentYielded.resolve();
      parked.resolve();
      leafEnded.resolve();
      await pendingPatch?.catch(() => {});
      await Promise.all(
        [...runIds].map((runId) => gateway.client.request("sessions.abort", { runId })),
      );
      stop();
      promotion.mockRestore();
      fixture.stream = undefined;
      fixture.beforeSettle = undefined;
      fixture.afterResult = undefined;
      fixture.beforeLifecycle = undefined;
    });
    const accepted = await gateway.client.request(
      "agent",
      { sessionKey: root, idempotencyKey: root, message: "PROOF_ROOT", deliver: false },
      { expectFinal: false },
    );
    expect(accepted).toMatchObject({ status: "accepted" });
    if (scenario.delayTerminal) {
      await Promise.race([terminalEntered.promise, completed.promise]);
      expect(delayedTerminals).toBe(1);
      expect(successorCount).toBe(0);
      terminalRelease.resolve();
    }
    await completed.promise;
    await pendingPatch;
    expect(gated).toBe(true);
    expect(failures).toEqual([]);
    expect(successorCount).toBe(1);
    expect(finalCount).toBe(1);
    expect(parentRuns.size).toBe(2); // followup and its successor; initial park preceded key capture.
    const history = await gateway.client.request<{
      messages: Array<{ role: string; content: unknown }>;
      sessionInfo: { label: string };
    }>("chat.history", { sessionKey: root });
    expect(
      history.messages.filter(
        (message) =>
          message.role === "assistant" && JSON.stringify(message.content).includes("ROOT_DONE"),
      ),
    ).toHaveLength(1);
    expect(history.sessionInfo.label).toBe(metadataLabel);
    expect(JSON.stringify(history)).not.toContain("Session access facts are unavailable");
  },
);
