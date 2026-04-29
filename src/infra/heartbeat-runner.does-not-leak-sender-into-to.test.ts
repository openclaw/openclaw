import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

installHeartbeatRunnerTestRuntime();

// Regression: when no real delivery target resolves, `resolveHeartbeatSenderId`
// returns the literal "heartbeat" sentinel as the From identifier. ctx.To used
// to mirror that, which then propagated into the session's persisted lastTo via
// `resolveLastToRaw` (originatingTo || toRaw fallback) whenever the session was
// next written. The corruption made every later `delivery.channel: "last"`
// dispatch from that session try to deliver to a username @heartbeat.
describe("runHeartbeatOnce ctx.To", () => {
  it("does not echo the sender sentinel into ctx.To when no delivery target resolves", async () => {
    await withTempHeartbeatSandbox(
      async ({ tmpDir, storePath, replySpy }) => {
        resetSystemEventsForTest();

        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: { every: "5m", target: "none" },
            },
          },
          channels: { telegram: { allowFrom: ["*"] } },
          session: { store: storePath },
        };

        const sessionKey = resolveMainSessionKey(cfg);
        // Pre-existing session with a real lastTo. The fix preserves it.
        const realLastTo = "telegram:6704095127";
        await fs.writeFile(
          storePath,
          JSON.stringify({
            [sessionKey]: {
              sessionId: "sid",
              updatedAt: Date.now(),
              lastChannel: "telegram",
              lastTo: realLastTo,
            },
          }),
        );

        // Force the heartbeat runner to actually invoke replySpy by enqueuing an
        // actionable system event for the session.
        enqueueSystemEvent("Reminder: probe ctx.To shape", { sessionKey });

        let capturedTo: unknown = "<not-captured>";
        let capturedFrom: unknown = "<not-captured>";
        replySpy.mockImplementation(async (ctx: { To?: unknown; From?: unknown }) => {
          capturedTo = ctx.To;
          capturedFrom = ctx.From;
          return [{ text: "ok" }];
        });

        const result = await runHeartbeatOnce({
          cfg,
          deps: {
            getReplyFromConfig: replySpy,
            getQueueSize: () => 0,
            nowMs: () => 0,
          },
        });

        expect(result.status).toBe("ran");
        // From may legitimately carry the "heartbeat" sentinel — that's the
        // documented self-event identity for the LLM prompt.
        expect(capturedFrom).toBeDefined();
        // To must NOT carry the sentinel; otherwise it leaks into lastTo.
        expect(capturedTo).not.toBe("heartbeat");

        // The session's persisted lastTo should be untouched after a heartbeat
        // turn that had no real recipient — the previously-saved real recipient
        // must survive.
        const persisted = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
          string,
          { lastTo?: string }
        >;
        expect(persisted[sessionKey]?.lastTo).toBe(realLastTo);
      },
      { prefix: "openclaw-hb-no-leak-" },
    );
  });
});
