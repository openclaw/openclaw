import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { agentCommandFromGatewayIngress } from "../agents/agent-command.js";
import type { runCliAgent as runCliAgentImpl } from "../agents/cli-runner.js";
import { supportedSpawnModelChoice } from "../agents/subagents/spawn/subagent-spawn.test-helpers.js";
import { createSessionsSendTool } from "../agents/tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "../agents/tools/sessions-spawn-tool.js";
import { loadConfig, writeConfigFile } from "../config/config.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { findTaskByRunId } from "../tasks/task-registry.js";
import { onTaskRegistryChange } from "../tasks/task-registry.store.js";
import { getTaskRunOwner } from "../tasks/task-run-owner.js";
import type { AgentRunRequest } from "./server-methods/agent-request-types.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { agentCommandMock, installGatewayTestHooks, rpcReq, testState } from "./test-helpers.js";

// External CLI execution is synthetic. Admission, command preparation,
// model selection, the shared CLI placement lane, and RPC settlement are real.
const runCliAgent = vi.hoisted(() => vi.fn<typeof runCliAgentImpl>());
vi.mock("../agents/cli-runner.js", () => ({ runCliAgent }));

const modelRef = "anthropic/claude-sonnet-4-6";
const agentConfig = {
  model: modelRef,
  models: { [modelRef]: { agentRuntime: { id: "claude-cli" } } },
  thinkingDefault: "off",
};
const tempDirs = useAutoCleanupTempDirTracker(afterAll);

describe("accepted agent session ordering", () => {
  let harness: GatewayServerHarness;
  let ws: WebSocket;
  installGatewayTestHooks({
    scope: "suite",
    setup: async () => {
      testState.agentConfig = agentConfig;
      // The prepared runtime owns its registry. Give its real
      // loader a tiny CLI plugin instead of mutating the Gateway's stub registry.
      const config = loadConfig();
      const rootDir = tempDirs.make("openclaw-ordering-cli-");
      const fixture = createColdPluginFixture({
        rootDir,
        pluginId: "ordering-cli",
        providerId: "anthropic",
        manifest: {
          channels: [],
          channelConfigs: {},
          providerAuthChoices: [],
          cliBackends: ["claude-cli"],
        },
      });
      await fs.writeFile(
        fixture.runtimeSource,
        `module.exports = {
        id: "ordering-cli",
        register(api) {
          api.registerCliBackend({ id: "claude-cli", modelProvider: "anthropic", config: { command: "not-executed" } });
        },
      };`,
      );
      await writeConfigFile({
        ...config,
        plugins: {
          load: { paths: [rootDir] },
          entries: { "ordering-cli": { enabled: true } },
        },
      });
      harness = await startGatewayServerHarness();
      ({ ws } = await harness.openClient());
    },
    cleanup: async () => {
      ws?.close();
      await harness?.close();
    },
  });
  afterEach(() => vi.restoreAllMocks());

  async function scenario(signal: AbortSignal) {
    testState.agentConfig = agentConfig;
    const prefix = randomUUID();
    let sessionKey = `agent:main:ordering-${prefix}`;
    const toolRunIds = new Map<string, string>();
    const runId = (name: string) => toolRunIds.get(name) ?? `${prefix}-${name}`;
    const spawnTask = `ordering-spawn-BASE:${prefix}`;
    const started: string[] = [];
    const preparations: string[] = [];
    const requests = new Map<string, AgentRunRequest>();
    type Gate = ReturnType<typeof gate>;
    const prepareGates = new Map<string, Gate>();
    const runnerGates = new Map<string, Gate>();
    function gate() {
      return {
        entered: createDeferred(),
        release: createDeferred(),
        failure: undefined as Error | undefined,
        aborted: createDeferred(),
        delayAbort: false,
      };
    }
    const hold = (name: string, phase: "prepare" | "runner" = "prepare") => {
      const held = gate();
      (phase === "prepare" ? prepareGates : runnerGates).set(runId(name), held);
      return held;
    };
    const release = () => {
      for (const held of [...prepareGates.values(), ...runnerGates.values()]) {
        held.release.resolve();
      }
    };
    signal.addEventListener("abort", release, { once: true });
    const realCommand = (await import("../agents/agent-command.js")).agentCommandFromGatewayIngress;
    agentCommandMock.mockImplementation((...args) =>
      realCommand(...(args as Parameters<typeof agentCommandFromGatewayIngress>)),
    );
    const preparation = await import("../agents/command/prepare.js");
    const prepare = preparation.prepareAgentCommandExecution;
    vi.spyOn(preparation, "prepareAgentCommandExecution").mockImplementation(async (...args) => {
      const id = args[0].runId ?? "missing-run-id";
      preparations.push(id);
      const held =
        prepareGates.get(id) ??
        (args[0].message?.includes(spawnTask) ? prepareGates.get(`${prefix}-BASE`) : undefined);
      if (held) {
        held.entered.resolve();
        // Hold the actual awaited command preparation boundary, before the
        // runtime can enqueue in its session lane. No timers or model claims.
        await racePromiseWithAbortSignal(held.release.promise, args[0].abortSignal);
        if (held.failure) {
          throw held.failure;
        }
      }
      return await prepare(...args);
    });
    runCliAgent.mockImplementation(async (params) => {
      const id = params.runId ?? "missing-run-id";
      started.push(id);
      await params.onExecutionStarted?.();
      const held = runnerGates.get(id);
      if (held) {
        held.entered.resolve();
        try {
          await racePromiseWithAbortSignal(held.release.promise, params.abortSignal);
        } catch (error) {
          held.aborted.resolve();
          if (held.delayAbort) {
            await held.release.promise;
          }
          throw error;
        }
        if (held.failure) {
          throw held.failure;
        }
      }
      return {
        payloads: [{ text: `result:${id}` }],
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId: params.sessionId,
            provider: "anthropic",
            model: "claude-sonnet-4-6",
          },
        },
      };
    });
    const admit = async (name: string, independent = false, interSession = false) => {
      const request = {
        sessionKey: independent ? `agent:main:peer-${prefix}` : sessionKey,
        message: name,
        idempotencyKey: runId(name),
        ...(interSession
          ? { inputProvenance: { kind: "inter_session" as const, sourceTool: "sessions_send" } }
          : {}),
      };
      const response = await rpcReq(ws, "agent", request);
      expect(response, JSON.stringify(response)).toMatchObject({
        ok: true,
        payload: { runId: runId(name), status: "accepted" },
      });
      requests.set(name, request);
    };
    const replay = (name: string) => rpcReq(ws, "agent", requests.get(name));
    const taskRegistered = async (name: string) => {
      const ready = createDeferred<NonNullable<ReturnType<typeof findTaskByRunId>>>();
      const read = () => {
        const task = findTaskByRunId(runId(name));
        if (task) {
          ready.resolve(task);
        }
      };
      const stop = onTaskRegistryChange(read);
      try {
        read();
        return await racePromiseWithAbortSignal(ready.promise, signal);
      } finally {
        stop();
      }
    };
    const terminal = async (name: string) => {
      const result = await rpcReq(ws, "agent.wait", { runId: runId(name), timeoutMs: 10_000 });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      return result.payload;
    };
    const entered = async (name: string, held: Gate) => {
      await Promise.race([
        held.entered.promise,
        terminal(name).then((outcome) => {
          throw new Error(`Did not enter ${name}: ${JSON.stringify(outcome)}`);
        }),
      ]);
    };
    const expectResult = async (name: string) => {
      expect(await terminal(name)).toMatchObject({ status: "ok" });
      // Exact idempotent replay must retain each original result after later turns.
      const replayed = await replay(name);
      expect(replayed, JSON.stringify(replayed)).toMatchObject({
        ok: true,
        payload: {
          runId: runId(name),
          status: "ok",
          result: { payloads: [{ text: `result:${runId(name)}` }] },
        },
      });
    };
    const expectCancellation = async (name: string) => {
      // Keep the shipped distinction: agent.wait exposes canonical cancellation
      // as error/rpc; the agent RPC replay retains its legacy timeout wire status.
      expect(await terminal(name)).toMatchObject({ status: "error", stopReason: "rpc" });
      expect(await rpcReq(ws, "agent", requests.get(name))).toMatchObject({
        ok: true,
        payload: { runId: runId(name), status: "timeout", stopReason: "rpc" },
      });
      expect(findTaskByRunId(runId(name))?.status).toBe("cancelled");
    };
    const spawn = async () => {
      const tool = createSessionsSpawnTool({
        agentSessionKey: `agent:main:peer-${prefix}`,
        config: loadConfig(),
      });
      const result = await tool.execute("spawn-base", {
        task: spawnTask,
        context: "isolated",
        cleanup: "keep",
        expectsCompletionMessage: false,
      });
      const details = result.details as {
        status?: string;
        runId?: string;
        childSessionKey?: string;
      };
      expect(details, JSON.stringify(result)).toMatchObject({ status: "accepted" });
      if (!details.runId || !details.childSessionKey) {
        throw new Error("Missing spawn acceptance identity");
      }
      toolRunIds.set("BASE", details.runId);
      sessionKey = details.childSessionKey;
      requests.set("BASE", { message: spawnTask, sessionKey, idempotencyKey: details.runId });
    };
    const followup = async (name: string) => {
      const tool = createSessionsSendTool({
        agentSessionKey: `agent:main:peer-${prefix}`,
        config: loadConfig(),
        idempotencyKey: runId(name),
      });
      const result = await tool.execute(`send-${name}`, {
        message: name,
        sessionKey,
        mode: "followup",
        timeoutSeconds: 0,
      });
      expect(result.details, JSON.stringify(result)).toMatchObject({
        status: "accepted",
        runId: runId(name),
      });
      requests.set(name, { message: name, sessionKey, idempotencyKey: runId(name) });
    };
    const peer = async () => {
      await admit("peer", true);
      await expectResult("peer");
    };
    const close = async () => {
      release();
      await Promise.allSettled([...requests.keys()].map(terminal));
      signal.removeEventListener("abort", release);
    };
    return {
      ws,
      get sessionKey() {
        return sessionKey;
      },
      runId,
      spawn,
      followup,
      started,
      preparations,
      hold,
      admit,
      terminal,
      replay,
      taskRegistered,
      entered,
      expectResult,
      expectCancellation,
      peer,
      close,
    };
  }

  async function observeExecutionWait(runId: string, signal: AbortSignal) {
    const sessionOrder = await import("./agent-turn/agent-session-execution-order.js");
    const waitForExecution = sessionOrder.waitForAgentSessionExecution;
    const entered = createDeferred();
    const seen = vi.fn();
    vi.spyOn(sessionOrder, "waitForAgentSessionExecution").mockImplementation((lease, params) => {
      if (params.runId === runId) {
        // Dispatch reaches this existing wait only after binding the task's live owner.
        seen();
        entered.resolve();
      }
      return waitForExecution(lease, params);
    });
    return { seen, wait: () => racePromiseWithAbortSignal(entered.promise, signal) };
  }

  it.for([false, true])(
    "orders fresh BASE/F1/F2 (inter-session=%s) despite delayed preparation",
    async (interSession, { signal }) => {
      const s = await scenario(signal);
      const base = s.hold("BASE");
      try {
        await s.admit("BASE");
        await s.entered("BASE", base);
        await s.admit("F1", false, interSession);
        await s.admit("F2", false, interSession);
        // Shipped replay contract: an accepted run that is still registered replays
        // as in_flight, never as a second acceptance or a phantom reservation.
        for (const name of ["BASE", "F1"]) {
          expect(await s.replay(name)).toMatchObject({
            ok: true,
            payload: { runId: s.runId(name), status: "in_flight" },
          });
        }
        await s.peer();
        // The independent session has fully completed while BASE is still preparing.
        expect(s.started).toEqual([s.runId("peer")]);
        base.release.resolve();
        for (const name of ["BASE", "F1", "F2"]) {
          await s.expectResult(name);
        }
        // Re-read the original twice after every follower settled; no duplicate execution.
        await s.expectResult("BASE");
        await s.expectResult("BASE");
        expect(s.started).toEqual(["peer", "BASE", "F1", "F2"].map(s.runId));
      } finally {
        await s.close();
      }
    },
  );

  it("orders followups of an already active turn across a second slow startup", async ({
    signal,
  }) => {
    const s = await scenario(signal);
    const base = s.hold("BASE", "runner");
    const first = s.hold("F1");
    try {
      await s.admit("BASE");
      await s.entered("BASE", base);
      await s.admit("F1");
      await s.admit("F2");
      base.release.resolve();
      await s.entered("F1", first);
      await s.peer();
      expect(s.started).toEqual(["BASE", "peer"].map(s.runId));
      first.release.resolve();
      for (const name of ["BASE", "F1", "F2"]) {
        await s.expectResult(name);
      }
      expect(s.started).toEqual(["BASE", "peer", "F1", "F2"].map(s.runId));
    } finally {
      await s.close();
    }
  });

  it("releases a preparation failure and does not reserve rejected work", async ({ signal }) => {
    const s = await scenario(signal);
    const base = s.hold("BASE");
    base.failure = new Error("synthetic preparation failure");
    try {
      const rejection = await rpcReq(s.ws, "agent", {
        message: "invalid target",
        sessionKey: s.sessionKey,
        agentId: "missing-agent",
        idempotencyKey: s.runId("rejected"),
      });
      expect(rejection.ok).toBe(false);
      await s.admit("BASE");
      await s.entered("BASE", base);
      await s.admit("F1");
      await s.admit("F2");
      base.release.resolve();
      expect(await s.terminal("BASE")).toMatchObject({
        status: "error",
        error: expect.stringContaining("synthetic preparation failure"),
      });
      await s.expectResult("F1");
      await s.expectResult("F2");
      expect(s.started).toEqual(["F1", "F2"].map(s.runId));
    } finally {
      await s.close();
    }
  });

  it.for(["chat.abort", "tasks.cancel"] as const)(
    "settles a queued %s without letting its successor overtake BASE",
    async (method, { signal }) => {
      const s = await scenario(signal);
      const base = s.hold("BASE", "runner");
      const f1ExecutionWait =
        method === "tasks.cancel" ? await observeExecutionWait(s.runId("F1"), signal) : undefined;
      try {
        await s.admit("BASE");
        await s.entered("BASE", base);
        await s.admit("F1");
        await s.admit("F2");
        if (method === "chat.abort") {
          expect(
            (await rpcReq(s.ws, method, { sessionKey: s.sessionKey, runId: s.runId("F1") })).ok,
          ).toBe(true);
        } else {
          const task = await s.taskRegistered("F1");
          await f1ExecutionWait?.wait();
          expect(getTaskRunOwner(task)).toBeDefined();
          const cancellation = await rpcReq(s.ws, method, { taskId: task.taskId });
          expect(cancellation, JSON.stringify(cancellation)).toMatchObject({
            ok: true,
            payload: { found: true, cancelled: true },
          });
        }
        await s.expectCancellation("F1");
        await s.peer();
        expect(s.started).toEqual(["BASE", "peer"].map(s.runId));
        expect(s.preparations).not.toContain(s.runId("F1"));
        base.release.resolve();
        await s.expectResult("BASE");
        await s.expectResult("F2");
        expect(s.started).toEqual(["BASE", "peer", "F2"].map(s.runId));
        expect(findTaskByRunId(s.runId("F1"))?.status).toBe("cancelled");
      } finally {
        await s.close();
      }
    },
  );

  it("waits for the live owner before cancelling a published queued task", async ({ signal }) => {
    const s = await scenario(signal);
    const base = s.hold("BASE", "runner");
    const bindingEntered = createDeferred();
    const bindingRelease = createDeferred();
    const f1ExecutionWait = await observeExecutionWait(s.runId("F1"), signal);
    const taskCreation = await import("../tasks/task-executor-create.async.js");
    const createTask = taskCreation.createRunningTaskRunCoreWithReceiptAsync;
    vi.spyOn(taskCreation, "createRunningTaskRunCoreWithReceiptAsync").mockImplementation(
      async (...args) => {
        const receipt = await createTask(...args);
        if (!receipt || args[0].runId !== s.runId("F1")) {
          return receipt;
        }
        const bindRunOwner = receipt.bindRunOwner;
        return {
          ...receipt,
          async bindRunOwner(...bindArgs) {
            // Widen the real publication-to-binding gap without replacing the owner.
            bindingEntered.resolve();
            await racePromiseWithAbortSignal(bindingRelease.promise, signal);
            return await bindRunOwner(...bindArgs);
          },
        };
      },
    );
    try {
      await s.admit("BASE");
      await s.entered("BASE", base);
      await s.admit("F1");
      await s.admit("F2");
      const task = await s.taskRegistered("F1");
      await racePromiseWithAbortSignal(bindingEntered.promise, signal);
      expect(f1ExecutionWait.seen).not.toHaveBeenCalled();
      expect(getTaskRunOwner(task)).toBeUndefined();
      const premature = await rpcReq(s.ws, "tasks.cancel", { taskId: task.taskId });
      expect(premature, JSON.stringify(premature)).toMatchObject({
        ok: true,
        payload: { found: true, cancelled: false },
      });
      expect(f1ExecutionWait.seen).not.toHaveBeenCalled();
      expect(s.preparations).not.toContain(s.runId("F1"));
      bindingRelease.resolve();
      await f1ExecutionWait.wait();
      expect(getTaskRunOwner(task)).toBeDefined();
      const cancellation = await rpcReq(s.ws, "tasks.cancel", { taskId: task.taskId });
      expect(cancellation, JSON.stringify(cancellation)).toMatchObject({
        ok: true,
        payload: { found: true, cancelled: true },
      });
      await s.expectCancellation("F1");
      await s.peer();
      expect(s.started).toEqual(["BASE", "peer"].map(s.runId));
      expect(s.preparations).not.toContain(s.runId("F1"));
      base.release.resolve();
      await s.expectResult("BASE");
      await s.expectResult("F2");
      expect(s.started).toEqual(["BASE", "peer", "F2"].map(s.runId));
    } finally {
      bindingRelease.resolve();
      await s.close();
    }
  });

  it("releases a cancelled startup for the next accepted turn", async ({ signal }) => {
    const s = await scenario(signal);
    const base = s.hold("BASE");
    try {
      await s.admit("BASE");
      await s.entered("BASE", base);
      await s.admit("F1");
      expect(
        (await rpcReq(s.ws, "chat.abort", { sessionKey: s.sessionKey, runId: s.runId("BASE") })).ok,
      ).toBe(true);
      await s.expectCancellation("BASE");
      await s.expectResult("F1");
      expect(s.started).toEqual([s.runId("F1")]);
    } finally {
      await s.close();
    }
  });
  it("releases a running backend failure for later accepted turns", async ({ signal }) => {
    const s = await scenario(signal);
    const base = s.hold("BASE", "runner");
    base.failure = new Error("synthetic backend failure");
    try {
      await s.admit("BASE");
      await s.entered("BASE", base);
      await s.admit("F1");
      await s.admit("F2");
      base.release.resolve();
      expect(await s.terminal("BASE")).toMatchObject({
        status: "error",
        error: expect.stringContaining("synthetic backend failure"),
      });
      await s.expectResult("F1");
      await s.expectResult("F2");
      expect(s.started).toEqual(["BASE", "F1", "F2"].map(s.runId));
    } finally {
      await s.close();
    }
  });

  it("holds cancelled active execution until the backend acknowledges stop", async ({ signal }) => {
    const s = await scenario(signal);
    const base = s.hold("BASE", "runner");
    base.delayAbort = true;
    try {
      await s.admit("BASE");
      await s.entered("BASE", base);
      await s.admit("F1");
      expect(
        (
          await rpcReq(s.ws, "chat.abort", {
            sessionKey: s.sessionKey,
            runId: s.runId("BASE"),
          })
        ).ok,
      ).toBe(true);
      await base.aborted.promise;
      await s.peer();
      expect(s.started).toEqual(["BASE", "peer"].map(s.runId));
      expect(s.preparations).not.toContain(s.runId("F1"));
      base.release.resolve();
      await s.expectCancellation("BASE");
      await s.expectResult("F1");
      expect(s.started).toEqual(["BASE", "peer", "F1"].map(s.runId));
    } finally {
      await s.close();
    }
  });

  it("keeps inter-session work yielding to later foreground input", async ({ signal }) => {
    const s = await scenario(signal);
    const background = s.hold("F1");
    try {
      await s.admit("BASE");
      await s.expectResult("BASE");
      await s.admit("F1", false, true);
      await s.entered("F1", background);
      await s.admit("F2", false, true);
      await s.admit("HUMAN");
      await s.expectResult("HUMAN");
      expect(s.started).toEqual(["BASE", "HUMAN"].map(s.runId));
      background.release.resolve();
      await s.expectResult("F1");
      await s.expectResult("F2");
      expect(s.started).toEqual(["BASE", "HUMAN", "F1", "F2"].map(s.runId));
    } finally {
      await s.close();
    }
  });
  it("orders actual sessions_spawn and sessions_send followup tool admissions", async ({
    signal,
  }) => {
    const s = await scenario(signal);
    const base = s.hold("BASE");
    // The fixture CLI plugin publishes no provider catalog for the child
    // model. Reuse the repository's supported model-choice
    // fixture for that one verification; spawn/send construction, target
    // resolution, admission, preparation, and the CLI lane stay real.
    const spawnRuntime = await import("../agents/subagents/spawn/subagent-spawn.runtime.js");
    vi.spyOn(spawnRuntime, "prepareModelChoice").mockImplementation(supportedSpawnModelChoice);
    try {
      // A real parent row, real visibility/policy checks, and in-process Gateway dispatch.
      await s.peer();
      await s.spawn();
      await s.entered("BASE", base);
      await s.followup("F1");
      await s.followup("F2");
      await s.admit("CHECKPOINT", true);
      await s.expectResult("CHECKPOINT");
      expect(s.started).toEqual(["peer", "CHECKPOINT"].map(s.runId));
      base.release.resolve();
      for (const name of ["BASE", "F1", "F2", "BASE"]) {
        await s.expectResult(name);
      }
      expect(s.started).toEqual(["peer", "CHECKPOINT", "BASE", "F1", "F2"].map(s.runId));
    } finally {
      await s.close();
    }
  });
});
