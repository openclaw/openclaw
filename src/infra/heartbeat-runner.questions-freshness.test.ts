import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionHistoryWorkerRequest } from "../config/sessions/session-history-types.js";
import * as historyWorker from "../config/sessions/session-history-worker-runtime.js";
import * as decisions from "../decisions/runtime.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { answers, withQuestions } from "./heartbeat-runner.questions.test-support.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import * as targets from "./outbound/targets.js";

const collector = vi.hoisted(() => vi.fn());
vi.mock("../cron/trigger-script.js", () => ({
  createCronScriptRuntime: () => ({ collectHeartbeatContext: collector }),
}));
installHeartbeatRunnerTestRuntime();
beforeEach(() => {
  collector.mockReset().mockImplementation(async (input) => ({
    kind: "collected",
    outputs: input.commands.map((command: string) => ({ command, output: "No change." })),
  }));
  vi.spyOn(decisions, "evaluateDecision").mockResolvedValue(answers());
});
afterEach(() => vi.restoreAllMocks());

it("retains the wake when an append overtakes the final worker count", async () => {
  const read = historyWorker.readSessionHistoryPageInWorker;
  let countReads = 0;
  await withQuestions(async ({ options, reply, scope }) => {
    vi.spyOn(historyWorker, "readSessionHistoryPageInWorker").mockImplementation((async (
      request: SessionHistoryWorkerRequest,
      signal?: AbortSignal,
    ) => {
      const result = await read(request, signal);
      // Return the unchanged snapshot only after the real append has committed.
      if (request.kind === "message-count" && ++countReads === 2) {
        await appendTranscriptMessage(scope, {
          eventId: "overtaking-message",
          parentId: "latest-user",
          message: { role: "user", content: [{ type: "text", text: "New work arrived." }] },
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

it("revalidates the preflight identity after delivery routing resets it", async () => {
  const route = targets.resolveHeartbeatDeliveryTargetWithSessionRoute;
  await withQuestions(async ({ options, reply, scope }) => {
    vi.spyOn(targets, "resolveHeartbeatDeliveryTargetWithSessionRoute").mockImplementation(
      async (...args) => {
        const result = await route(...args);
        // This commit occurs before question evaluation installs its identity watcher.
        await replaceSessionEntry(scope, { sessionId: "replacement", updatedAt: Date.now() });
        return result;
      },
    );
    expect(await runHeartbeatOnce(options)).toMatchObject({
      status: "skipped",
      reason: "requests-in-flight",
    });
    expect(collector).not.toHaveBeenCalled();
    expect(decisions.evaluateDecision).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });
});

it.each(["decisionAssistance", "decisionModel"] as const)(
  "withdraws provider admission when %s is disabled",
  async (setting) => {
    await withQuestions(async ({ options, reply }) => {
      vi.mocked(decisions.evaluateDecision).mockImplementation(async (_batch, evaluation) => {
        expect(evaluation.admit?.()).toBe(true);
        const defaults = options.cfg!.agents!.defaults!;
        if (setting === "decisionAssistance") {
          defaults.experimental!.decisionAssistance = false;
        } else {
          delete defaults.decisionModel;
        }
        expect(evaluation.admit?.()).toBe(false);
        return { status: "unavailable", reason: "disabled" };
      });
      expect((await runHeartbeatOnce(options)).status).toBe("ran");
      expect(reply).toHaveBeenCalledOnce();
    });
  },
);

it("does not turn a closed Decision authority into fallback work", async () => {
  const closed = new Error("Decision consumer authority closed.");
  vi.mocked(decisions.evaluateDecision).mockRejectedValue(closed);
  await withQuestions(async ({ options, reply }) => {
    await expect(runHeartbeatOnce(options)).rejects.toBe(closed);
    expect(reply).not.toHaveBeenCalled();
  });
});

it.each(["x".repeat(9_000), "界".repeat(3_000)])(
  "keeps the ordinary turn when the newest message exceeds the evidence budget",
  async (text) => {
    await withQuestions(async ({ options, reply, scope }) => {
      await appendTranscriptMessage(scope, {
        eventId: "oversized-newest",
        parentId: "latest-user",
        message: { role: "user", content: [{ type: "text", text }] },
      });
      expect((await runHeartbeatOnce(options)).status).toBe("ran");
      expect(reply).toHaveBeenCalledOnce();
      expect(collector).not.toHaveBeenCalled();
      expect(decisions.evaluateDecision).not.toHaveBeenCalled();
    });
  },
);
