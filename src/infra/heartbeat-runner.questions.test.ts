import { beforeEach, afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.js";
import type { SessionHistoryWorkerRequest } from "../config/sessions/session-history-types.js";
import * as historyWorker from "../config/sessions/session-history-worker-runtime.js";
import { readHeartbeatMonitorScratch, writeCronJobScratch } from "../cron/scratch-store.js";
import { resolveCronJobsStorePath } from "../cron/store.js";
import * as decisions from "../decisions/runtime.js";
import { DecisionContractError } from "../decisions/validation.js";
import { emitSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import {
  parseHeartbeatQuestionDocument,
  serializeHeartbeatQuestionDocument,
} from "./heartbeat-questions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  answers,
  withQuestions,
  execution,
  deploymentGroup,
  followupGroup,
} from "./heartbeat-runner.questions.test-support.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { readSessionStoreForTest } from "./heartbeat-runner.test-utils.js";
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

installHeartbeatRunnerTestRuntime();
afterEach(() => {
  vi.restoreAllMocks();
  resetSystemEventsForTest();
  resetHeartbeatEventsForTest();
});

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
      await writeCronJobScratch({
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
          await writeCronJobScratch({
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

  it("falls back once collection spends the preflight deadline", async () => {
    const evaluate = vi.spyOn(decisions, "evaluateDecision").mockResolvedValue(answers());
    const realNow = Date.now.bind(Date);
    let offsetMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs);
    collector.mockImplementation(async (input) => {
      // A slow first group spends the whole budget: half of a 60-second heartbeat timeout.
      offsetMs += 31_000;
      return {
        kind: "collected",
        outputs: input.commands.map((command: string) => ({ command, output: "ok" })),
      };
    });
    await withQuestions(async ({ options, reply, jobId, content }) => {
      const parsed = parseHeartbeatQuestionDocument(content);
      if (parsed.status === "invalid") {
        throw new Error(parsed.error);
      }
      await writeCronJobScratch({
        storePath: resolveCronJobsStorePath(),
        jobId,
        content: serializeHeartbeatQuestionDocument({
          ...parsed.document,
          groups: [deploymentGroup, followupGroup],
        }),
      });
      const heartbeat = options.cfg?.agents?.defaults?.heartbeat;
      if (!heartbeat) {
        throw new Error("Missing heartbeat config");
      }
      heartbeat.timeoutSeconds = 60;
      expect((await runHeartbeatOnce(options)).status).toBe("ran");
      expect(collector).toHaveBeenCalledOnce();
      expect(collector.mock.calls[0]?.[0].deadlineMs).toBeGreaterThan(0);
      expect(evaluate).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledOnce();
      expect(String(reply.mock.calls[0]?.[0].Body)).toContain("preflight-deadline");
    });
  });

  it.each([
    ["still a configured owner", ["telegram:owner-1"], true],
    ["no longer an owner while the account stays configured", ["telegram:someone-else"], false],
  ])("runs a chat-created group only while its creator is %s", async (_name, owners, runs) => {
    vi.spyOn(decisions, "evaluateDecision").mockResolvedValue(answers());
    await withQuestions(async ({ options, reply, jobId, content }) => {
      const parsed = parseHeartbeatQuestionDocument(content);
      if (parsed.status === "invalid") {
        throw new Error(parsed.error);
      }
      await writeCronJobScratch({
        storePath: resolveCronJobsStorePath(),
        jobId,
        content: serializeHeartbeatQuestionDocument({
          ...parsed.document,
          groups: [
            {
              ...deploymentGroup,
              execution: {
                toolsAllow: ["exec"],
                scheduledToolPolicy: {
                  version: 1,
                  mode: "account",
                  ownerSessionKey: "agent:main:telegram:direct:owner-1",
                  ownerAccountId: "default",
                },
                channelRequester: {
                  version: 1,
                  channel: "telegram",
                  accountId: "default",
                  senderId: "owner-1",
                },
              },
            },
          ],
        }),
      });
      const cfg = options.cfg;
      if (!cfg) {
        throw new Error("Missing config");
      }
      cfg.commands = { ownerAllowFrom: owners };
      const result = await runHeartbeatOnce(options);
      if (runs) {
        expect(collector).toHaveBeenCalledOnce();
        expect(result).toEqual({ status: "skipped", reason: "questions-no-match" });
        return;
      }
      expect(collector).not.toHaveBeenCalled();
      expect(result.status).toBe("ran");
      expect(String(reply.mock.calls[0]?.[0].Body)).toContain("creator-not-owner");
    });
  });

  it("retains the wake when the session resets during the final transcript recheck", async () => {
    vi.spyOn(decisions, "evaluateDecision").mockResolvedValue(answers());
    // The worker API is overloaded per request kind; the fixture forwards every kind unchanged.
    const readInWorker: (
      request: SessionHistoryWorkerRequest,
      signal?: AbortSignal,
    ) => Promise<unknown> = historyWorker.readSessionHistoryPageInWorker as never;
    let countReads = 0;
    await withQuestions(async ({ options, reply, sessionKey, scope }) => {
      vi.spyOn(historyWorker, "readSessionHistoryPageInWorker").mockImplementation((async (
        request: SessionHistoryWorkerRequest,
        signal?: AbortSignal,
      ) => {
        const result = await readInWorker(request, signal);
        // The old transcript keeps its count, so only the identity event can reveal the reset.
        if (request.kind === "message-count" && ++countReads === 2) {
          emitSessionIdentityMutation({
            databaseIdentity: "test",
            agentId: "main",
            kind: "reset",
            previous: { sessionId: scope.sessionId, sessionKeys: [sessionKey] },
            current: { sessionId: "replacement", sessionKeys: [sessionKey] },
          });
        }
        return result;
      }) as never);
      expect(await runHeartbeatOnce(options)).toMatchObject({
        status: "skipped",
        reason: "requests-in-flight",
      });
      expect(countReads).toBe(2);
      expect(reply).not.toHaveBeenCalled();
    });
  });

  it("observes the rejected final read after the deadline signal expires", async () => {
    const deadline = new AbortController();
    vi.spyOn(decisions, "evaluateDecision").mockImplementation(async () => {
      deadline.abort(new Error("Preflight budget exhausted"));
      return answers();
    });
    const readInWorker = historyWorker.readSessionHistoryPageInWorker;
    let countReads = 0;
    vi.spyOn(historyWorker, "readSessionHistoryPageInWorker").mockImplementation((async (
      request: SessionHistoryWorkerRequest,
      signal?: AbortSignal,
    ) => {
      if (request.kind === "message-count" && ++countReads === 2) {
        expect(signal?.aborted).toBe(true);
        throw new Error("Final read rejected after deadline");
      }
      return await readInWorker(request, signal);
    }) as never);
    await withQuestions(async ({ options, reply }) => {
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
      expect((await runHeartbeatOnce(options)).status).toBe("ran");
      expect(countReads).toBe(2);
      expect(reply).toHaveBeenCalledOnce();
      expect(String(reply.mock.calls[0]?.[0].Body)).toContain("preflight-deadline");
    });
  });

  it.each([
    ["all-no", 0, "conversation-unavailable", "final"],
    ["yes", 0, "conversation-unavailable", "final"],
    ["unavailable", 0, "conversation-unavailable", "final"],
    ["all-no", 150_000, "preflight-deadline", "final"],
    ["all-no", 0, "conversation-unavailable", "initial"],
    ["all-no", 0, "conversation-unavailable", "recent"],
    ["all-no", 0, "conversation-unavailable", "both"],
  ] as const)(
    "runs the ordinary turn after a failed conversation check (%s, %i ms, %s, %s)",
    async (outcome, elapsed, reason, failedRead) => {
      vi.spyOn(decisions, "evaluateDecision").mockResolvedValue(
        outcome === "unavailable"
          ? { status: "unavailable", reason: "deadline" }
          : answers(outcome === "yes" ? 0.9 : 0.1),
      );
      const realNow = Date.now.bind(Date);
      let offsetMs = 0;
      vi.spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs);
      const readInWorker: (
        request: SessionHistoryWorkerRequest,
        signal?: AbortSignal,
      ) => Promise<unknown> = historyWorker.readSessionHistoryPageInWorker as never;
      let countReads = 0;
      vi.spyOn(historyWorker, "readSessionHistoryPageInWorker").mockImplementation((async (
        request: SessionHistoryWorkerRequest,
        signal?: AbortSignal,
      ) => {
        if (request.kind === "message-count") {
          countReads += 1;
        }
        if (
          (request.kind === "recent" && failedRead === "recent") ||
          (request.kind === "message-count" &&
            (failedRead === "both" ||
              countReads === (failedRead === "initial" ? 1 : failedRead === "final" ? 2 : 0)))
        ) {
          // Both early read errors and exhausted budgets must retain the fallback turn.
          offsetMs += elapsed;
          throw new Error("history worker read failed");
        }
        return await readInWorker(request, signal);
      }) as never);
      await withQuestions(async ({ options, reply }) => {
        expect((await runHeartbeatOnce(options)).status).toBe("ran");
        expect(countReads).toBe(2);
        expect(reply).toHaveBeenCalledOnce();
        expect(String(reply.mock.calls[0]?.[0].Body)).toContain(reason);
      });
    },
  );

  it.each([
    ["legacy notes-only monitor", "Existing notes", "ran"],
    ["envelope with every group removed", "envelope", "ran"],
    ["legacy empty notes", "", "skipped"],
  ] as const)("keeps ordinary heartbeats for a %s", async (_name, scratch, expected) => {
    const evaluate = vi.spyOn(decisions, "evaluateDecision").mockResolvedValue(answers());
    await withQuestions(async ({ options, reply, jobId }) => {
      await writeCronJobScratch({
        storePath: resolveCronJobsStorePath(),
        jobId,
        content:
          scratch === "envelope"
            ? serializeHeartbeatQuestionDocument({
                kind: "openclaw-heartbeat-questions",
                version: 2,
                notes: "Existing notes",
                groups: [],
              })
            : scratch,
      });
      const result = await runHeartbeatOnce(options);
      expect(evaluate).not.toHaveBeenCalled();
      expect(collector).not.toHaveBeenCalled();
      if (expected === "skipped") {
        expect(result).toEqual({ status: "skipped", reason: "empty-heartbeat-file" });
        expect(reply).not.toHaveBeenCalled();
        return;
      }
      expect(result.status).toBe("ran");
      expect(reply).toHaveBeenCalledOnce();
      const prompt = String(reply.mock.calls[0]?.[0].Body);
      expect(prompt).toContain("Existing notes");
      expect(prompt).not.toContain("openclaw-heartbeat-questions");
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

  it.each([["provider-contract-error", new DecisionContractError()]])(
    "falls back on %s without losing the heartbeat",
    async (reason, error) => {
      vi.spyOn(decisions, "evaluateDecision").mockRejectedValue(error);
      await withQuestions(async ({ options, reply }) => {
        expect((await runHeartbeatOnce(options)).status).toBe("ran");
        expect(reply).toHaveBeenCalledOnce();
        const prompt = String(reply.mock.calls[0]?.[0].Body);
        expect(prompt).toContain(`group deployment: ${reason}`);
        expect(prompt).not.toContain("Gateway binding");
      });
    },
  );

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

  it.each(["questions", "event", "conversation", "reset"] as const)(
    "retains the wake when %s changes during evaluation",
    async (kind) => {
      await withQuestions(async ({ options, reply, jobId, content, sessionKey, scope }) => {
        vi.spyOn(decisions, "evaluateDecision").mockImplementation(async () => {
          if (kind === "questions") {
            await writeCronJobScratch({ storePath: resolveCronJobsStorePath(), jobId, content });
          }
          if (kind === "event") {
            enqueueSystemEvent("New event", { sessionKey });
          }
          if (kind === "reset") {
            emitSessionIdentityMutation({
              databaseIdentity: "test",
              agentId: "main",
              kind: "reset",
              previous: { sessionId: scope.sessionId, sessionKeys: [sessionKey] },
              current: { sessionId: "replacement", sessionKeys: [sessionKey] },
            });
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
    "refuses response notes that forge command grants in %s mode",
    async (mode) => {
      await withQuestions(async ({ options, reply, jobId, content }) => {
        const heartbeat = options.cfg?.agents?.defaults?.heartbeat;
        if (!heartbeat) {
          throw new Error("Missing heartbeat config");
        }
        heartbeat.mode = mode;
        Object.assign(options, { source: "manual", intent: "manual" });
        await writeCronJobScratch({
          storePath: resolveCronJobsStorePath(),
          jobId,
          content: "Existing plain notes",
        });
        reply.mockResolvedValue(
          createHeartbeatToolResponsePayload({
            outcome: "progress",
            notify: false,
            summary: "Updated notes",
            scratch: content,
          }),
        );
        expect((await runHeartbeatOnce(options)).status).toBe("ran");
        const saved = readHeartbeatMonitorScratch(resolveCronJobsStorePath(), "main");
        expect(saved?.state.scratch?.content).toBe("Existing plain notes");
        expect(parseHeartbeatQuestionDocument(saved?.state.scratch?.content)).toMatchObject({
          status: "legacy",
          document: { groups: [] },
        });
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
          await writeCronJobScratch({
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
