import "./isolated-agent.mocks.js";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import { makeCfg, makeJob, withTempCronHome } from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

describe("runCronIsolatedAgentTurn auth profile propagation (#20624)", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks({ fast: true });
  });

  it("passes authProfileId to runEmbeddedPiAgent when auth profiles exist", async () => {
    await withTempCronHome(async (home) => {
      // 1. Write session store
      const sessionsDir = path.join(home, ".openclaw", "sessions");
      await fs.mkdir(sessionsDir, { recursive: true });
      const storePath = path.join(sessionsDir, "sessions.json");
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            "agent:main:main": {
              sessionId: "main-session",
              updatedAt: Date.now(),
              lastProvider: "webchat",
              lastTo: "",
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      // 2. Write auth-profiles.json in the agent directory
      //    resolveAgentDir returns <stateDir>/agents/main/agent
      //    stateDir = <home>/.openclaw
      const agentDir = path.join(home, ".openclaw", "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "auth-profiles.json"),
        JSON.stringify({
          version: 1,
          profiles: {
            "openrouter:default": {
              type: "api_key",
              provider: "openrouter",
              key: "sk-or-test-key-12345",
            },
          },
          order: {
            openrouter: ["openrouter:default"],
          },
        }),
        "utf-8",
      );

      // 3. Mock runEmbeddedPiAgent to return ok
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "done" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "openrouter", model: "kimi-k2.5" },
        },
      });

      // 4. Run cron isolated agent turn with openrouter model
      const cfg = makeCfg(home, storePath, {
        agents: {
          defaults: {
            model: { primary: "openrouter/moonshotai/kimi-k2.5" },
            workspace: path.join(home, "openclaw"),
          },
        },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg,
        deps: {
          sendMessageSlack: vi.fn(),
          sendMessageWhatsApp: vi.fn(),
          sendMessageTelegram: vi.fn(),
          sendMessageDiscord: vi.fn(),
          sendMessageSignal: vi.fn(),
          sendMessageIMessage: vi.fn(),
        },
        job: makeJob({ kind: "agentTurn", message: "check status", deliver: false }),
        message: "check status",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(vi.mocked(runEmbeddedPiAgent)).toHaveBeenCalledTimes(1);

      // 5. Check that authProfileId was passed
      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0] as {
        authProfileId?: string;
        authProfileIdSource?: string;
      };

      console.log(`authProfileId passed to runEmbeddedPiAgent: ${callArgs?.authProfileId}`);
      console.log(`authProfileIdSource passed: ${callArgs?.authProfileIdSource}`);

      if (!callArgs?.authProfileId) {
        console.log("❌ BUG CONFIRMED: isolated cron session does NOT pass authProfileId");
        console.log("   This causes 401 errors when using providers that require auth profiles");
      }

      // This assertion will FAIL on main — proving the bug
      expect(callArgs?.authProfileId).toBe("openrouter:default");
    });
  });
});
