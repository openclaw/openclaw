import "./isolated-agent.mocks.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sessionOverride from "../agents/auth-profiles/session-override.js";
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

describe("isolated cron resolveSessionAuthProfileOverride isNewSession (#62783)", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks({ fast: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes isNewSession=false when sessionTarget is isolated", async () => {
    const spy = vi.spyOn(sessionOverride, "resolveSessionAuthProfileOverride");
    spy.mockResolvedValue("openrouter:default");

    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
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
              key: "sk-or-test-key",
            },
          },
          order: { openrouter: ["openrouter:default"] },
        }),
        "utf-8",
      );

      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "openrouter", model: "kimi-k2.5" },
        },
      });

      const cfg = makeCfg(home, storePath, {
        agents: {
          defaults: {
            model: { primary: "openrouter/moonshotai/kimi-k2.5" },
            workspace: path.join(home, "openclaw"),
          },
        },
      });

      await runCronIsolatedAgentTurn({
        cfg,
        deps: createCliDeps(),
        job: {
          ...makeJob({ kind: "agentTurn", message: "hi" }),
          sessionTarget: "isolated",
          delivery: { mode: "none" },
        },
        message: "hi",
        sessionKey: "cron:auth-flag-1",
        lane: "cron",
      });
    });

    const openRouterCall = spy.mock.calls.find((c) => c[0]?.provider === "openrouter");
    expect(
      openRouterCall,
      "resolveSessionAuthProfileOverride was not called with provider openrouter",
    ).toBeDefined();
    expect(openRouterCall?.[0]?.isNewSession).toBe(false);
  });
});
