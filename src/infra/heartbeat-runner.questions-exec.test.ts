import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import type { OpenClawConfig } from "../config/config.js";
import { readHeartbeatMonitorScratch, writeCronJobScratch } from "../cron/scratch-store.js";
import { resolveCronJobsStorePath } from "../cron/store.js";
import * as decisions from "../decisions/runtime.js";
import { serializeHeartbeatQuestionDocument } from "./heartbeat-questions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  seedMainSessionStore,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

installHeartbeatRunnerTestRuntime();
afterEach(() => {
  vi.restoreAllMocks();
});

// Persisted chat grant -> scheduled heartbeat -> real collector and exec tool; only the
// decision provider and the owner allowlist are fixtures.
describe("question-mode heartbeat saved chat grant", () => {
  it.each([
    ["still a configured owner", ["telegram:owner-1"], true],
    [
      "dropped from the owners while its account stays configured",
      ["telegram:someone-else"],
      false,
    ],
  ])("runs the saved command only while its creator is %s", async (_name, owners, runs) => {
    vi.spyOn(decisions, "evaluateDecision").mockResolvedValue({
      status: "ok",
      result: { model: "fixture", answers: { due: { type: "boolean", probabilityTrue: 0.1 } } },
      provenance: { providerId: "fixture", rubricVersion: "2", runtimeGeneration: "fixture" },
    });
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const marker = path.join(tmpDir, "command.marker");
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            decisionModel: "typesafe/jev-1.13.0",
            experimental: { decisionAssistance: true },
            heartbeat: {
              every: "30m",
              target: "telegram",
              mode: "questions",
              isolatedSession: true,
            },
          },
        },
        channels: { telegram: { enabled: true, botToken: "test", allowFrom: ["owner-1"] } },
        commands: { ownerAllowFrom: owners },
        session: { store: storePath },
        tools: { exec: { security: "full", ask: "off" } },
      };
      await seedMainSessionStore(storePath, cfg, {
        sessionId: "questions-exec",
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "owner-1",
      });
      const monitor = readHeartbeatMonitorScratch(resolveCronJobsStorePath(), "main");
      if (!monitor) {
        throw new Error("Missing monitor fixture");
      }
      await writeCronJobScratch({
        storePath: resolveCronJobsStorePath(),
        jobId: monitor.jobId,
        content: serializeHeartbeatQuestionDocument({
          kind: "openclaw-heartbeat-questions",
          version: 2,
          notes: "Watch the marker.",
          groups: [
            {
              id: "marker",
              commands: [`printf ok > ${JSON.stringify(marker)}`],
              questions: [{ id: "due", question: "Is anything due?" }],
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
      replySpy.mockResolvedValue(
        createHeartbeatToolResponsePayload({ outcome: "no_change", notify: false, summary: "ok" }),
      );
      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        source: "interval",
        intent: "scheduled",
        deps: { getReplyFromConfig: replySpy, telegram: vi.fn(), getQueueSize: () => 0 },
      });
      expect(fs.existsSync(marker)).toBe(runs);
      if (runs) {
        expect(result).toEqual({ status: "skipped", reason: "questions-no-match" });
        return;
      }
      expect(result.status).toBe("ran");
      expect(String(replySpy.mock.calls[0]?.[0].Body)).toContain("creator-not-owner");
    });
  });
});
