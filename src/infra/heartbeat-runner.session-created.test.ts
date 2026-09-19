import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as embeddedAgent from "../agents/embedded-agent.js";
import { withFullRuntimeReplyConfig } from "../auto-reply/reply/get-reply-fast-path.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import { resetCronActiveJobs } from "../cron/active-jobs.js";
import { recordSessionCreated } from "../sessions/session-created.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  seedMainSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
} from "./heartbeat-runner.test-utils.js";
import { enqueueSystemEvent, peekSystemEvents, resetSystemEventsForTest } from "./system-events.js";

let state: OpenClawTestState | undefined;
beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
  resetCronActiveJobs();
  resetSystemEventsForTest();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await state?.cleanup();
  state = undefined;
  resetSystemEventsForTest();
});

it.each(["heartbeat wake", "heartbeat poll", "build failure"])(
  "delivers a creation notice about %s once through a cron wake",
  async (topic) => {
    state = await createOpenClawTestState({
      label: "session-created-heartbeat",
      env: { OPENCLAW_TEST_FAST: "0" },
    });
    const storePath = path.join(state.root, "sessions.json");
    const cfg = withFullRuntimeReplyConfig({
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          model: { primary: "mock-openai/gpt-5.6-luna" },
          models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
          heartbeat: { every: "5m", target: "none" },
        },
      },
      plugins: { enabled: false },
      session: { store: storePath },
    });
    await state.writeConfig(cfg);
    const sessionKey = await seedMainSessionStore(storePath, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: "-100155462274",
    });
    const title = `Investigate ${topic}`;
    recordSessionCreated(cfg, {
      sessionKey: "agent:main:dashboard:new-task",
      agentId: "main",
      entry: {
        sessionId: "new-task",
        updatedAt: Date.now(),
        label: title,
        createdVia: "operator",
        createdActor: { type: "human", source: "profile", id: "profile-alice" },
      },
    });
    enqueueSystemEvent("Reminder: check the work queue", {
      sessionKey,
      contextKey: "cron:queue-check",
    });
    const runAgent = vi
      .spyOn(embeddedAgent, "runEmbeddedAgent")
      .mockImplementation(async (params) => ({
        payloads: [{ text: "Handled internally" }],
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId: params.sessionId,
            provider: "mock-openai",
            model: "gpt-5.6-luna",
          },
        },
      }));
    const run = () =>
      runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        source: "cron",
        reason: "cron:queue-check",
        deps: { getReplyFromConfig },
      });

    expect((await run()).status).toBe("ran");
    expect(runAgent).toHaveBeenCalledTimes(1);
    const input = expectDefined(runAgent.mock.calls[0]?.[0], "first agent input");
    expect(input.currentInboundContext?.text ?? "").toContain(title);
    expect(input.currentInboundContext?.text ?? "").toMatch(/System:.*New session created/u);
    expect(input.currentInboundContext?.fragments).toContainEqual(
      expect.objectContaining({ kind: "conversation-data", text: expect.stringContaining(title) }),
    );
    expect(input.prompt).toContain("The reminder content is:\n\nReminder: check the work queue");
    expect(input.prompt).not.toContain(title);
    expect(peekSystemEvents(sessionKey)).toEqual([]);

    expect((await run()).status).toBe("ran");
    expect(runAgent).toHaveBeenCalledTimes(2);
    const next = expectDefined(runAgent.mock.calls[1]?.[0], "second agent input");
    expect(next.currentInboundContext?.text ?? "").not.toContain(title);
    expect(next.prompt).not.toContain(title);
  },
);
