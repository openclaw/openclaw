import { vi } from "vitest";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import type { OpenClawConfig } from "../config/config.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.js";
import { readHeartbeatMonitorScratch, writeCronJobScratch } from "../cron/scratch-store.js";
import { resolveCronJobsStorePath } from "../cron/store.js";
import type { DecisionOutcome } from "../decisions/types.js";
import { serializeHeartbeatQuestionDocument } from "./heartbeat-questions.js";
import type { HeartbeatRunOptions } from "./heartbeat-runner-execution.js";
import {
  seedMainSessionStore,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

export const execution = {
  toolsAllow: ["exec"],
  scheduledToolPolicy: { version: 1 as const, mode: "trusted" as const },
};
export const deploymentGroup = {
  id: "deployment",
  commands: ["deployment-status"],
  execution,
  questions: [
    { id: "blocked", question: "Is the deployment blocked?" },
    { id: "ready", question: "Is the deployment ready for review?" },
  ],
};
export const followupGroup = {
  id: "followup",
  commands: ["followup-status"],
  execution,
  questions: [{ id: "followup", question: "Is follow-up needed?" }],
};

/** Builds deterministic Decision answers for heartbeat gating tests. */
export function answers(first = 0.1, second = 0.2): Extract<DecisionOutcome, { status: "ok" }> {
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

/** Seeds a question-enabled monitor and isolates its session, scratch and delivery fixtures. */
export async function withQuestions(
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
    await writeCronJobScratch({
      storePath: resolveCronJobsStorePath(),
      jobId: monitor.jobId,
      content,
    });
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
