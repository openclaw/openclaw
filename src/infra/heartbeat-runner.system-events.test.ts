// Tests that heartbeat prompt injection covers system events beyond
// exec-completion and cron (e.g. Slack interaction payloads). Fix for
// #99544 — follow-up to #61502.
import { describe, expect, it, afterEach } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { seedMainSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";
import { resetSystemEventsForTest } from "./system-events.js";
import { enqueueSystemEventEntry } from "./system-events.js";

installHeartbeatRunnerTestRuntime({ includeSlack: true });

afterEach(() => {
  resetSystemEventsForTest();
});

describe("heartbeat system event injection (#99544)", () => {
  it("injects pending interaction system event text into the heartbeat prompt", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      // The default HEARTBEAT.md ("- Check status\n") provides a task so
      // the runner has something to run. source: "hook" simulates a Slack
      // interactive button wake so shouldInspectPendingEvents is true and
      // the interaction value gets injected into the prompt body.
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "last" },
          },
        },
        session: { store: storePath },
      };

      // Use the "slack" channel so the wake matches a Slack interaction
      // delivery context and exercises the real interaction injection path.
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "slack",
        lastProvider: "slack",
        lastTo: "U123456",
      });

      // Enqueue a synthetic Slack interaction system event. It is NOT an
      // exec-completion or cron marker, so it lands on the generic heartbeat
      // path — the code path where interaction events were silently dropped
      // before the fix.
      enqueueSystemEventEntry(
        JSON.stringify({
          type: "block_actions",
          user: { id: "U123456", name: "test-user" },
          actions: [{ action_id: "approve_pr", value: "merge-99544" }],
        }),
        {
          sessionKey,
          contextKey: "slack:interaction:block_actions",
          deliveryContext: { channel: "slack", to: "U123456", accountId: "T000000" },
        },
      );

      // Capture the prompt Body that would be sent to the model.
      let capturedBody = "";
      replySpy.mockImplementation(async (ctx) => {
        capturedBody = ctx.Body ?? "";
        return { text: "ok" };
      });

      await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        source: "hook",
        deps: { getReplyFromConfig: replySpy },
      });

      // The prompt Body MUST frame the interaction payload with System:
      // semantics (matching drainFormattedSystemEvents convention).
      expect(capturedBody).toContain("System:");
      expect(capturedBody).toContain("approve_pr");
      expect(capturedBody).toContain("merge-99544");
      // The generic heartbeat prompt should still be present (appended
      // after the injected event text).
      expect(capturedBody).toContain("heartbeat");
    });
  });

  it("does not inject system events when there are no pending entries", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "last" },
          },
        },
        session: { store: storePath },
      };

      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "slack",
        lastProvider: "slack",
        lastTo: "U123456",
      });

      // No system events enqueued — prompt should be the plain heartbeat
      // with no injected interaction payload.
      let capturedBody = "";
      replySpy.mockImplementation(async (ctx) => {
        capturedBody = ctx.Body ?? "";
        return { text: "ok" };
      });

      await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        source: "hook",
        deps: { getReplyFromConfig: replySpy },
      });

      expect(capturedBody).toContain("heartbeat");
      expect(capturedBody).not.toContain("merge-99544");
    });
  });
});
