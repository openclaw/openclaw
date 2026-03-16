import "./isolated-agent.mocks.js";
import fs from "node:fs/promises";
import path from "node:path";
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

describe("runCronIsolatedAgentTurn auth profile propagation (#20624)", () => {
  const timeoutMs = process.platform === "win32" ? 240_000 : 120_000;

  beforeEach(() => {
    setupIsolatedAgentTurnMocks({ fast: true });
  });

  it(
    "passes authProfileId to runEmbeddedPiAgent when auth profiles exist",
    async () => {
      await withTempCronHome(async (home) => {
        const storePath = await writeSessionStore(home, {
          lastProvider: "webchat",
          lastTo: "",
        });

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
          deps: createCliDeps(),
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

        expect(callArgs?.authProfileId).toBe("openrouter:default");
      });
    },
    timeoutMs,
  );
});
