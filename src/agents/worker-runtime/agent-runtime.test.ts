import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  onAgentEvent as onParentAgentEvent,
  resetAgentEventsForTest,
  type AgentEventPayload,
} from "../../infra/agent-events.js";
import type { RunAgentAttemptParams } from "../command/attempt-execution.js";
import { LiveSessionModelSwitchError } from "../live-model-switch-error.js";
import {
  AgentWorkerUnsupportedParamsError,
  runAgentAttemptInWorker,
  shouldRunAgentCommandAttemptInWorker,
} from "./agent-runtime.js";
import { serializeWorkerError } from "./errors.js";

function createFixtureWorkerUrl(): URL {
  const source = `
    import fs from "node:fs/promises";
    import { parentPort } from "node:worker_threads";

    let runStarted = false;

    function post(message) {
      parentPort.postMessage(message);
    }

    async function writeSessionStoreUpdate(message, tag) {
      if (!message.params.storePath || !message.params.sessionKey) {
        return;
      }
      await fs.writeFile(
        message.params.storePath,
        JSON.stringify({
          [message.params.sessionKey]: {
            sessionId: message.params.sessionId,
            updatedAt: 456,
            model: "worker-" + tag
          }
        }, null, 2)
      );
    }

    parentPort.on("message", async (message) => {
      if (message.type === "abort") {
        if (runStarted) {
          post({ type: "error", error: { name: "AbortError", message: "aborted:" + String(message.reason ?? "") } });
        }
        return;
      }

      if (message.type !== "run" || runStarted) {
        return;
      }

      runStarted = true;
      if (message.initialAbort) {
        post({ type: "error", error: { name: "AbortError", message: "initial-aborted:" + String(message.initialAbort.reason ?? "") } });
        return;
      }
      post({
        type: "agentEvent",
        origin: "runtime",
        event: {
          runId: message.params.runId,
          seq: 7,
          ts: 123,
          stream: "tool",
          data: { phase: "runtime", runId: message.params.runId }
        }
      });
      post({
        type: "agentEvent",
        origin: "runtime",
        event: {
          runId: "child-run",
          seq: 1,
          ts: 124,
          stream: "lifecycle",
          data: { phase: "end", runId: "child-run" }
        }
      });
      post({
        type: "agentEvent",
        origin: "callback",
        event: {
          stream: "lifecycle",
          sessionKey: message.params.sessionKey,
          data: { phase: "fixture", runId: message.params.runId }
        }
      });
      post({
        type: "userMessagePersisted",
        message: { role: "user", content: [{ type: "text", text: message.params.body }] }
      });

      if (message.params.body === "throw") {
        post({ type: "error", error: { name: "FixtureError", message: "fixture failed", code: "FIXTURE" } });
        return;
      }
      if (message.params.body === "mutate-store-then-throw") {
        await writeSessionStoreUpdate(message, "error");
        post({ type: "error", error: { name: "FixtureError", message: "fixture failed", code: "FIXTURE" } });
        return;
      }
      if (message.params.body === "switch") {
        post({
          type: "error",
          error: {
            name: "LiveSessionModelSwitchError",
            message: "Live session model switch requested: anthropic/claude-sonnet-4.6",
            control: {
              type: "liveSessionModelSwitch",
              provider: "anthropic",
              model: "claude-sonnet-4.6",
              authProfileId: "profile-1",
              authProfileIdSource: "user"
            }
          }
        });
        return;
      }
      if (message.params.body === "wait") {
        return;
      }
      if (message.params.body === "mutate-store") {
        await writeSessionStoreUpdate(message, "result");
      }

      post({
        type: "result",
        result: {
          payloads: [{ text: "worker:" + message.params.body }],
          meta: {
            durationMs: 1,
            finalAssistantVisibleText: "worker:" + message.params.body,
            agentMeta: {
              sessionId: message.params.sessionId,
              provider: message.params.providerOverride ?? "fixture",
              model: message.params.modelOverride ?? "fixture-model"
            },
            executionTrace: { runner: "embedded" }
          }
        }
      });
    });
  `;
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

async function makeWorkerParams(body: string): Promise<RunAgentAttemptParams> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-worker-"));
  tmpDirs.push(tmpDir);
  return {
    providerOverride: "openai",
    originalProvider: "openai",
    modelOverride: "gpt-5.5",
    cfg: {} as OpenClawConfig,
    sessionEntry: undefined,
    sessionId: "session-worker-test",
    sessionKey: "agent:main:worker-test",
    sessionAgentId: "main",
    sessionFile: path.join(tmpDir, "session.jsonl"),
    workspaceDir: tmpDir,
    body,
    isFallbackRetry: false,
    resolvedThinkLevel: "medium",
    timeoutMs: 1_000,
    runId: "run-worker-test",
    opts: { message: body, senderIsOwner: false },
    runContext: {} as RunAgentAttemptParams["runContext"],
    spawnedBy: undefined,
    messageChannel: undefined,
    skillsSnapshot: undefined,
    resolvedVerboseLevel: undefined,
    agentDir: tmpDir,
    onAgentEvent: vi.fn(),
    authProfileProvider: "openai",
    sessionHasHistory: false,
  };
}

const tmpDirs: string[] = [];

describe("agent runtime worker bridge", () => {
  afterEach(async () => {
    resetAgentEventsForTest();
    await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("recognizes config and explicit environment overrides", () => {
    expect(
      shouldRunAgentCommandAttemptInWorker({
        config: {
          agents: { defaults: { experimental: { runtimeIsolation: { mode: "worker" } } } },
        } as OpenClawConfig,
        env: {},
      }),
    ).toBe(true);
    expect(
      shouldRunAgentCommandAttemptInWorker({
        config: {
          agents: { defaults: { experimental: { runtimeIsolation: { mode: "worker" } } } },
        } as OpenClawConfig,
        env: { OPENCLAW_AGENT_RUNTIME_WORKER: "0" },
      }),
    ).toBe(false);
    expect(
      shouldRunAgentCommandAttemptInWorker({
        config: {} as OpenClawConfig,
        env: { OPENCLAW_AGENT_RUNTIME_WORKER: "yes" },
      }),
    ).toBe(true);
    expect(
      shouldRunAgentCommandAttemptInWorker({
        config: {} as OpenClawConfig,
        env: { OPENCLAW_AGENT_WORKER_EXPERIMENT: "1" },
      }),
    ).toBe(true);
  });

  it("runs an agent attempt through a real worker and proxies supported callbacks", async () => {
    const onAgentEvent = vi.fn();
    const onUserMessagePersisted = vi.fn();
    const parentEvents: AgentEventPayload[] = [];
    const stopParentEvents = onParentAgentEvent((event) => {
      parentEvents.push(event);
    });

    const result = await runAgentAttemptInWorker(
      {
        ...(await makeWorkerParams("hello")),
        onAgentEvent,
        onUserMessagePersisted,
      },
      { workerUrl: createFixtureWorkerUrl(), execArgv: [], usePermissions: false },
    );
    stopParentEvents();

    expect(result.payloads?.[0]?.text).toBe("worker:hello");
    expect(result.meta.agentMeta).toMatchObject({
      sessionId: "session-worker-test",
      provider: "openai",
      model: "gpt-5.5",
    });
    expect(parentEvents).toEqual([
      expect.objectContaining({
        runId: "run-worker-test",
        stream: "tool",
        sessionKey: "agent:main:worker-test",
        data: { phase: "runtime", runId: "run-worker-test" },
        seq: expect.any(Number),
        ts: expect.any(Number),
      }),
      expect.objectContaining({
        runId: "child-run",
        stream: "lifecycle",
        data: { phase: "end", runId: "child-run" },
        seq: expect.any(Number),
        ts: expect.any(Number),
      }),
    ]);
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "tool",
      sessionKey: "agent:main:worker-test",
      data: { phase: "runtime", runId: "run-worker-test" },
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      sessionKey: "agent:main:worker-test",
      data: { phase: "fixture", runId: "run-worker-test" },
    });
    expect(onAgentEvent).not.toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end", runId: "child-run" },
    });
    expect(onUserMessagePersisted).toHaveBeenCalledWith({
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("propagates structured worker errors", async () => {
    await expect(
      runAgentAttemptInWorker(await makeWorkerParams("throw"), {
        workerUrl: createFixtureWorkerUrl(),
        execArgv: [],
        usePermissions: false,
      }),
    ).rejects.toMatchObject({
      name: "FixtureError",
      message: "fixture failed",
      code: "FIXTURE",
    });
  });

  it("refreshes parent session store state after a worker result", async () => {
    const params = await makeWorkerParams("mutate-store");
    const sessionStore: Record<string, SessionEntry> = {
      [params.sessionKey!]: {
        sessionId: params.sessionId,
        updatedAt: 1,
        model: "parent-stale",
        cliSessionBindings: { "claude-cli": { sessionId: "stale-cli-session" } },
      },
    };
    const storePath = path.join(path.dirname(params.sessionFile), "sessions.json");
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

    await runAgentAttemptInWorker(
      {
        ...params,
        sessionStore,
        storePath,
      },
      { workerUrl: createFixtureWorkerUrl(), execArgv: [], usePermissions: false },
    );

    expect(sessionStore[params.sessionKey!]).toMatchObject({
      sessionId: params.sessionId,
      updatedAt: 456,
      model: "worker-result",
    });
    expect(sessionStore[params.sessionKey!]?.cliSessionBindings).toBeUndefined();
  });

  it("refreshes parent session store state after a worker error", async () => {
    const params = await makeWorkerParams("mutate-store-then-throw");
    const sessionStore: Record<string, SessionEntry> = {
      [params.sessionKey!]: {
        sessionId: params.sessionId,
        updatedAt: 1,
        model: "parent-stale",
        cliSessionBindings: { "claude-cli": { sessionId: "stale-cli-session" } },
      },
    };
    const storePath = path.join(path.dirname(params.sessionFile), "sessions.json");
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

    await expect(
      runAgentAttemptInWorker(
        {
          ...params,
          sessionStore,
          storePath,
        },
        { workerUrl: createFixtureWorkerUrl(), execArgv: [], usePermissions: false },
      ),
    ).rejects.toMatchObject({
      name: "FixtureError",
    });

    expect(sessionStore[params.sessionKey!]).toMatchObject({
      sessionId: params.sessionId,
      updatedAt: 456,
      model: "worker-error",
    });
    expect(sessionStore[params.sessionKey!]?.cliSessionBindings).toBeUndefined();
  });

  it("preserves live model switch errors across the worker boundary", async () => {
    const error = new LiveSessionModelSwitchError({
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      authProfileId: "profile-1",
      authProfileIdSource: "user",
    });

    expect(serializeWorkerError(error)).toMatchObject({
      type: "error",
      error: {
        name: "LiveSessionModelSwitchError",
        control: {
          type: "liveSessionModelSwitch",
          provider: "anthropic",
          model: "claude-sonnet-4.6",
          authProfileId: "profile-1",
          authProfileIdSource: "user",
        },
      },
    });

    await expect(
      runAgentAttemptInWorker(await makeWorkerParams("switch"), {
        workerUrl: createFixtureWorkerUrl(),
        execArgv: [],
        usePermissions: false,
      }),
    ).rejects.toMatchObject({
      name: "LiveSessionModelSwitchError",
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      authProfileId: "profile-1",
      authProfileIdSource: "user",
    });
    await expect(
      runAgentAttemptInWorker(await makeWorkerParams("switch"), {
        workerUrl: createFixtureWorkerUrl(),
        execArgv: [],
        usePermissions: false,
      }),
    ).rejects.toBeInstanceOf(LiveSessionModelSwitchError);
  });

  it("forwards aborts into the worker", async () => {
    const controller = new AbortController();
    const promise = runAgentAttemptInWorker(
      {
        ...(await makeWorkerParams("wait")),
        opts: { message: "wait", senderIsOwner: false, abortSignal: controller.signal },
      },
      { workerUrl: createFixtureWorkerUrl(), execArgv: [], usePermissions: false },
    );

    controller.abort("stop");

    await expect(promise).rejects.toMatchObject({
      name: "AbortError",
      message: "aborted:stop",
    });
  });

  it("preserves an already-aborted signal when starting the worker run", async () => {
    const controller = new AbortController();
    controller.abort("already stopped");

    await expect(
      runAgentAttemptInWorker(
        {
          ...(await makeWorkerParams("hello")),
          opts: {
            message: "hello",
            senderIsOwner: false,
            abortSignal: controller.signal,
          },
        },
        { workerUrl: createFixtureWorkerUrl(), execArgv: [], usePermissions: false },
      ),
    ).rejects.toMatchObject({
      name: "AbortError",
      message: "initial-aborted:already stopped",
    });
  });

  it("rejects invalid abort signal params before spawning a worker", async () => {
    await expect(
      runAgentAttemptInWorker(
        {
          ...(await makeWorkerParams("hello")),
          opts: {
            message: "hello",
            senderIsOwner: false,
            abortSignal: "bad" as unknown as AbortSignal,
          },
        },
        { workerUrl: createFixtureWorkerUrl(), execArgv: [], usePermissions: false },
      ),
    ).rejects.toBeInstanceOf(AgentWorkerUnsupportedParamsError);
  });
});
