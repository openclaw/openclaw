import { beforeEach, afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import type { OpenClawConfig } from "../config/config.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.js";
import { readHeartbeatMonitorScratch, writeCronJobScratch } from "../cron/scratch-store.js";
import { resolveCronJobsStorePath } from "../cron/store.js";
import * as decisions from "../decisions/runtime.js";
import type { DecisionOutcome } from "../decisions/types.js";
import { DecisionContractError } from "../decisions/validation.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import {
  parseHeartbeatQuestionDocument,
  serializeHeartbeatQuestionDocument,
} from "./heartbeat-questions.js";
import type { HeartbeatRunOptions } from "./heartbeat-runner-execution.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  readSessionStoreForTest,
  seedMainSessionStore,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

const collector = vi.hoisted(() => vi.fn());
const wake = vi.hoisted(() => ({ signal: undefined as AbortSignal | undefined }));
vi.mock("./heartbeat-wake.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./heartbeat-wake.js")>();
  return {
    ...actual,
    getHeartbeatWakeAbortSignal: () => wake.signal ?? actual.getHeartbeatWakeAbortSignal(),
  };
});
vi.mock("../cron/trigger-script.js", () => ({
  createCronScriptRuntime: () => ({ collectHeartbeatContext: collector }),
}));
beforeEach(() => {
  collector.mockReset().mockImplementation(async (input) => ({
    kind: "collected",
    outputs: input.commands.map((command: string) => ({
      command,
      output: "Deployment is ready for review.",
    })),
  }));
});
const execution = {
  toolsAllow: ["exec"],
  scheduledToolPolicy: { version: 1 as const, mode: "trusted" as const },
};
const deploymentGroup = {
  id: "deployment",
  commands: ["deployment-status"],
  execution,
  questions: [
    { id: "blocked", question: "Is the deployment blocked?" },
    { id: "ready", question: "Is the deployment ready for review?" },
  ],
};
const followupGroup = {
  id: "followup",
  commands: ["followup-status"],
  execution,
  questions: [{ id: "followup", question: "Is follow-up needed?" }],
};

installHeartbeatRunnerTestRuntime();
afterEach(() => {
  vi.restoreAllMocks();
  resetSystemEventsForTest();
  resetHeartbeatEventsForTest();
});

function answers(first = 0.1, second = 0.2): Extract<DecisionOutcome, { status: "ok" }> {
  return {
    status: "ok",
    result: {
      model: "fixture",
      answers: {
        blocked: { type: "boolean", probabilityTrue: first },
        ready: { type: "boolean", probabilityTrue: second },
      },
    },
    provenance: { providerId: "fixture", rubricVersion: "1", runtimeGeneration: "fixture" },
  };
}

async function withQuestions(
  run: (fixture: {
    options: HeartbeatRunOptions;
    reply: Parameters<Parameters<typeof withTempTelegramHeartbeatSandbox>[0]>[0]["replySpy"];
    send: ReturnType<typeof vi.fn>;
    storePath: string;
    sessionKey: string;
    scope: { agentId: string; sessionKey: string; sessionId: string; storePath: string };
    jobId: string;
    content: string;
  }) => Promise<void>,
) {
  await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmpDir,
          decisionModel: "typesafe/jev-1.13.0",
          experimental: { decisionAssistance: true },
          heartbeat: { every: "30m", target: "telegram", mode: "questions", isolatedSession: true },
        },
      },
      channels: { telegram: { enabled: true, botToken: "test", allowFrom: ["owner"] } },
      session: { store: storePath },
    };
    const sessionKey = await seedMainSessionStore(storePath, cfg, {
      sessionId: "questions-conversation",
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: "owner",
    });
    const scope = { agentId: "main", sessionKey, sessionId: "questions-conversation", storePath };
    await appendTranscriptMessage(scope, {
      eventId: "latest-user",
      parentId: null,
      message: {
        role: "user",
        content: [{ type: "text", text: "Deployment is ready for review." }],
      },
    });
    const monitor = readHeartbeatMonitorScratch(resolveCronJobsStorePath(), "main");
    if (!monitor) {
      throw new Error("Missing monitor fixture");
    }
    const content = serializeHeartbeatQuestionDocument({
      kind: "openclaw-heartbeat-questions",
      version: 2,
      notes: "Watch the deployment.",
      groups: [deploymentGroup],
    });
    writeCronJobScratch({ storePath: resolveCronJobsStorePath(), jobId: monitor.jobId, content });
    replySpy.mockResolvedValue(
      createHeartbeatToolResponsePayload({
        outcome: "no_change",
        notify: false,
        summary: "Checked",
      }),
    );
    const send = vi.fn().mockResolvedValue({ messageId: "unexpected" });
    await run({
      options: {
        cfg,
        agentId: "main",
        source: "interval",
        intent: "scheduled",
        deps: { getReplyFromConfig: replySpy, telegram: send, getQueueSize: () => 0 },
      },
      reply: replySpy,
      send,
      storePath,
      sessionKey,
      scope,
      jobId: monitor.jobId,
      content,
    });
  });
}

describe("question-mode heartbeat dispatch", () => {
  it("skips all-no without rotating sessions or notifying, using group output with conversation and notes", async () => {
    const evaluate = vi.spyOn(decisions, "evaluateDecision").mockResolvedValue(answers());
    await withQuestions(async ({ options, reply, send, storePath }) => {
      const before = readSessionStoreForTest(storePath);
      expect(await runHeartbeatOnce(options)).toEqual({
        status: "skipped",
        reason: "questions-no-match",
      });
      expect(evaluate).toHaveBeenCalledOnce();
      expect(evaluate.mock.calls[0]?.[0]).toMatchObject({
        state: {
          notes: "Watch the deployment.",
          recentConversation: [{ role: "user", text: "Deployment is ready for review." }],
          group: "deployment",
          commands: [{ command: "deployment-status", output: "Deployment is ready for review." }],
        },
      });
      expect(reply).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(readSessionStoreForTest(storePath)).toEqual(before);
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: "skipped",
        reason: "questions-no-match",
      });
    });
  });

  it("isolates group state and starts one agent when a later group matches", async () => {
    const evaluate = vi
      .spyOn(decisions, "evaluateDecision")
      .mockResolvedValueOnce(answers())
      .mockResolvedValueOnce({
        ...answers(),
        status: "ok",
        result: {
          model: "fixture",
          answers: { followup: { type: "boolean", probabilityTrue: 0.9 } },
        },
      });
    collector.mockImplementation(async (input) => ({
      kind: "collected",
      outputs: input.commands.map((command: string) => ({
        command,
        output: command === "followup-status" ? "Needs follow-up" : "Deployment completed",
      })),
    }));
    await withQuestions(async ({ options, reply, jobId, content }) => {
      const parsed = parseHeartbeatQuestionDocument(content);
      if (parsed.status === "invalid") {
        throw new Error(parsed.error);
      }
      writeCronJobScratch({
        storePath: resolveCronJobsStorePath(),
        jobId,
        content: serializeHeartbeatQuestionDocument({
          ...parsed.document,
          groups: [deploymentGroup, followupGroup],
        }),
      });
      expect((await runHeartbeatOnce(options)).status).toBe("ran");
      expect(evaluate).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(evaluate.mock.calls[0]?.[0])).not.toContain("followup-status");
      expect(JSON.stringify(evaluate.mock.calls[1]?.[0])).not.toContain("deployment-status");
      expect(reply).toHaveBeenCalledOnce();
      expect(String(reply.mock.calls[0]?.[0].Body)).toContain("Needs follow-up");
    });
  });

  it.each(["command-failure", "oversized-request"])(
    "falls back before decision evaluation on %s",
    async (failure) => {
      const evaluate = vi.spyOn(decisions, "evaluateDecision").mockResolvedValue(answers());
      collector.mockResolvedValue(
        failure === "command-failure"
          ? { kind: "error", code: "timeout", error: "Timeout" }
          : {
              kind: "collected",
              outputs: [{ command: "status", output: "x".repeat(12 * 1024) }],
            },
      );
      await withQuestions(async ({ options, reply, jobId, content }) => {
        if (failure === "oversized-request") {
          const parsed = parseHeartbeatQuestionDocument(content);
          if (parsed.status === "invalid") {
            throw new Error(parsed.error);
          }
          writeCronJobScratch({
            storePath: resolveCronJobsStorePath(),
            jobId,
            content: serializeHeartbeatQuestionDocument({
              ...parsed.document,
              notes: "n".repeat(13 * 1024),
            }),
          });
        }
        expect((await runHeartbeatOnce(options)).status).toBe("ran");
        expect(evaluate).not.toHaveBeenCalled();
        expect(reply).toHaveBeenCalledOnce();
        expect(String(reply.mock.calls[0]?.[0].Body)).toContain("group deployment");
      });
    },
  );

  it("runs the normal agent exactly once when any question meets the yes threshold", async () => {
    vi.spyOn(decisions, "evaluateDecision").mockResolvedValue(answers(0.1, 0.5));
    await withQuestions(async ({ options, reply }) => {
      expect((await runHeartbeatOnce(options)).status).toBe("ran");
      expect(reply).toHaveBeenCalledOnce();
      const prompt = String(reply.mock.calls[0]?.[0].Body);
      expect(prompt).toContain("ready: Is the deployment ready for review?");
      expect(prompt).toContain("Watch the deployment.");
      expect(prompt).toContain("Deployment is ready for review.");
      expect(prompt).not.toContain("openclaw-heartbeat-questions");
    });
  });

  it.each([undefined, "agent"] as const)("keeps ordinary mode unchanged (%s)", async (mode) => {
    const evaluate = vi.spyOn(decisions, "evaluateDecision").mockResolvedValue(answers());
    await withQuestions(async ({ options, reply }) => {
      const heartbeat = options.cfg?.agents?.defaults?.heartbeat;
      if (!heartbeat) {
        throw new Error("Missing heartbeat config");
      }
      heartbeat.mode = mode;
      expect((await runHeartbeatOnce(options)).status).toBe("ran");
      expect(reply).toHaveBeenCalledOnce();
      expect(evaluate).not.toHaveBeenCalled();
    });
  });

  it.each(["decisionModel", "decisionAssistance"] as const)(
    "keeps ordinary heartbeats when the user has not enabled %s",
    async (missing) => {
      const evaluate = vi.spyOn(decisions, "evaluateDecision").mockResolvedValue(answers());
      await withQuestions(async ({ options, reply }) => {
        const defaults = options.cfg?.agents?.defaults;
        if (!defaults) {
          throw new Error("Missing agent defaults");
        }
        if (missing === "decisionModel") {
          delete defaults.decisionModel;
        } else {
          delete defaults.experimental;
        }
        expect((await runHeartbeatOnce(options)).status).toBe("ran");
        expect(evaluate).not.toHaveBeenCalled();
        expect(collector).not.toHaveBeenCalled();
        expect(reply).toHaveBeenCalledOnce();
        expect(String(reply.mock.calls[0]?.[0].Body)).not.toContain("openclaw-heartbeat-questions");
      });
    },
  );

  it("settles an empty question list without either model", async () => {
    const evaluate = vi.spyOn(decisions, "evaluateDecision").mockResolvedValue(answers());
    await withQuestions(async ({ options, reply, jobId }) => {
      writeCronJobScratch({
        storePath: resolveCronJobsStorePath(),
        jobId,
        content: "Existing notes",
      });
      expect(await runHeartbeatOnce(options)).toEqual({
        status: "skipped",
        reason: "questions-empty",
      });
      expect(evaluate).not.toHaveBeenCalled();
      expect(reply).not.toHaveBeenCalled();
    });
  });

  it.each(["manual", "task", "event"] as const)("does not gate %s work", async (kind) => {
    const evaluate = vi.spyOn(decisions, "evaluateDecision").mockResolvedValue(answers());
    await withQuestions(async ({ options, reply, sessionKey }) => {
      if (kind === "manual") {
        Object.assign(options, { source: "manual", intent: "manual" });
      }
      if (kind === "task") {
        options.tasks = [{ jobId: "due-task", name: "Task", prompt: "Do due work" }];
      }
      if (kind === "event") {
        enqueueSystemEvent("A background job needs attention", { sessionKey });
      }
      expect((await runHeartbeatOnce(options)).status).toBe("ran");
      expect(evaluate).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledOnce();
    });
  });

  it("falls back to the normal agent when the provider is unavailable", async () => {
    vi.spyOn(decisions, "evaluateDecision").mockResolvedValue({
      status: "unavailable",
      reason: "deadline",
    });
    await withQuestions(async ({ options, reply }) => {
      expect((await runHeartbeatOnce(options)).status).toBe("ran");
      expect(reply).toHaveBeenCalledOnce();
      const prompt = String(reply.mock.calls[0]?.[0].Body);
      expect(prompt).toContain("blocked: Is the deployment blocked?");
      expect(prompt).toContain("ready: Is the deployment ready for review?");
      expect(prompt).toContain("Deployment is ready for review.");
    });
  });

  it.each([
    ["provider-contract-error", new DecisionContractError()],
    ["decision-error", new Error("Decision evaluation requires its current Gateway binding.")],
  ])("falls back on %s without losing the heartbeat", async (reason, error) => {
    vi.spyOn(decisions, "evaluateDecision").mockRejectedValue(error);
    await withQuestions(async ({ options, reply }) => {
      expect((await runHeartbeatOnce(options)).status).toBe("ran");
      expect(reply).toHaveBeenCalledOnce();
      const prompt = String(reply.mock.calls[0]?.[0].Body);
      expect(prompt).toContain(`group deployment: ${reason}`);
      expect(prompt).not.toContain("Gateway binding");
    });
  });

  it("does not start fallback work when the wake is cancelled during evaluation", async () => {
    const controller = new AbortController();
    const cancelled = new DOMException("Wake cancelled", "AbortError");
    wake.signal = controller.signal;
    onTestFinished(() => {
      wake.signal = undefined;
    });
    vi.spyOn(decisions, "evaluateDecision").mockImplementation(async () => {
      controller.abort(cancelled);
      throw cancelled;
    });
    await withQuestions(async ({ options, reply }) => {
      await expect(runHeartbeatOnce(options)).rejects.toBe(cancelled);
      expect(reply).not.toHaveBeenCalled();
    });
  });

  it.each(["questions", "event", "conversation"] as const)(
    "retains the wake when %s changes during evaluation",
    async (kind) => {
      await withQuestions(async ({ options, reply, jobId, content, sessionKey, scope }) => {
        vi.spyOn(decisions, "evaluateDecision").mockImplementation(async () => {
          if (kind === "questions") {
            writeCronJobScratch({ storePath: resolveCronJobsStorePath(), jobId, content });
          }
          if (kind === "event") {
            enqueueSystemEvent("New event", { sessionKey });
          }
          if (kind === "conversation") {
            await appendTranscriptMessage(scope, {
              eventId: "new-message",
              parentId: "latest-user",
              message: { role: "user", content: [{ type: "text", text: "New urgent work" }] },
            });
          }
          return answers();
        });
        expect(await runHeartbeatOnce(options)).toMatchObject({
          status: "skipped",
          reason: "requests-in-flight",
        });
        expect(reply).not.toHaveBeenCalled();
        if (kind === "event") {
          expect(peekSystemEventEntries(sessionKey)).toHaveLength(1);
        }
      });
    },
  );

  it.each(["questions", "agent"] as const)(
    "preserves saved questions when %s mode updates notes",
    async (mode) => {
      await withQuestions(async ({ options, reply }) => {
        const heartbeat = options.cfg?.agents?.defaults?.heartbeat;
        if (!heartbeat) {
          throw new Error("Missing heartbeat config");
        }
        heartbeat.mode = mode;
        Object.assign(options, { source: "manual", intent: "manual" });
        reply.mockResolvedValue(
          createHeartbeatToolResponsePayload({
            outcome: "progress",
            notify: false,
            summary: "Updated notes",
            scratch: "Deployment completed.",
          }),
        );
        expect((await runHeartbeatOnce(options)).status).toBe("ran");
        const saved = readHeartbeatMonitorScratch(resolveCronJobsStorePath(), "main");
        expect(parseHeartbeatQuestionDocument(saved?.state.scratch?.content)).toMatchObject({
          status: "valid",
          document: {
            notes: "Deployment completed.",
            groups: [deploymentGroup],
          },
        });
      });
    },
  );
  it.each([false, true])(
    "merges question edits but protects concurrent notes (notes changed=%s)",
    async (notesChanged) => {
      await withQuestions(async ({ options, reply, jobId, content }) => {
        Object.assign(options, { source: "manual", intent: "manual" });
        reply.mockImplementation(async () => {
          const parsed = parseHeartbeatQuestionDocument(content);
          if (parsed.status === "invalid") {
            throw new Error("Invalid fixture");
          }
          writeCronJobScratch({
            storePath: resolveCronJobsStorePath(),
            jobId,
            content: serializeHeartbeatQuestionDocument({
              ...parsed.document,
              notes: notesChanged ? "Concurrent notes" : parsed.document.notes,
              groups: [followupGroup],
            }),
          });
          return createHeartbeatToolResponsePayload({
            outcome: "progress",
            notify: false,
            summary: "Updated",
            scratch: "New heartbeat notes",
          });
        });
        expect((await runHeartbeatOnce(options)).status).toBe("ran");
        const saved = readHeartbeatMonitorScratch(resolveCronJobsStorePath(), "main");
        expect(parseHeartbeatQuestionDocument(saved?.state.scratch?.content)).toMatchObject({
          status: "valid",
          document: {
            notes: notesChanged ? "Concurrent notes" : "New heartbeat notes",
            groups: [followupGroup],
          },
        });
      });
    },
  );
});
