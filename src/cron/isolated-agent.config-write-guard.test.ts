import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { createCliDeps } from "./isolated-agent.delivery.test-helpers.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  withTempCronHome,
  writeSessionStore,
} from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

describe("isolated cron sessions must not have config-write tools (#44940)", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks({ fast: true });
  });

  it("passes senderIsOwner=false so cron and gateway tools are stripped", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "done" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "anthropic", model: "claude-haiku-4-5" },
        },
      });

      const cfg = makeCfg(home, storePath);

      const res = await runCronIsolatedAgentTurn({
        cfg,
        deps: createCliDeps(),
        job: makeJob({ kind: "agentTurn", message: "check status", deliver: false }),
        message: "check status",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(vi.mocked(runEmbeddedPiAgent)).toHaveBeenCalledTimes(1);

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0] as {
        senderIsOwner?: boolean;
      };

      // senderIsOwner must be false for isolated cron sessions to prevent
      // models from rewriting their own cron job config via cron.update or
      // config.apply tools.
      expect(callArgs?.senderIsOwner).toBe(false);
    });
  });
});
