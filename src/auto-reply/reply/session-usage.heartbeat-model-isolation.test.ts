/**
 * Regression test for #21524:
 * Heartbeat model override must not overwrite the main session's model fields.
 *
 * persistSessionUsageUpdate() is called after every agent run.  When a heartbeat
 * uses a temporary model override, the caller (agent-runner) must omit
 * modelUsed / providerUsed so the session keeps the main agent's model.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore } from "../../config/sessions/store.js";
import { listSessionsFromStore } from "../../gateway/session-utils.js";
import { persistSessionUsageUpdate } from "./session-usage.js";

describe("persistSessionUsageUpdate – heartbeat model isolation (#21524)", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function setup(seedModel: string, seedProvider: string) {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-21524-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const sessionKey = "agent:default:main";
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId: "sid-main",
            updatedAt: Date.now() - 60_000,
            model: seedModel,
            modelProvider: seedProvider,
            lastChannel: "webchat",
            lastTo: "user1",
          },
        },
        null,
        2,
      ),
    );
    return { storePath, sessionKey };
  }

  function readSessionModel(storePath: string, sessionKey: string) {
    const store = loadSessionStore(storePath);
    const cfg: OpenClawConfig = {
      agents: { defaults: {} },
    };
    const result = listSessionsFromStore({
      cfg,
      storePath,
      store,
      opts: { includeGlobal: false, includeUnknown: false },
    });
    return result.sessions.find((s) => s.key === sessionKey);
  }

  it("preserves main session model when heartbeat omits modelUsed/providerUsed", async () => {
    const { storePath, sessionKey } = await setup("claude-sonnet-4.6", "anthropic");

    // Simulate heartbeat run: usage is persisted but model fields are omitted
    // (this is what agent-runner now does for heartbeat model overrides)
    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: { input: 100, output: 50 },
      modelUsed: undefined,
      providerUsed: undefined,
      contextTokensUsed: 8192,
    });

    const session = readSessionModel(storePath, sessionKey);
    expect(session).toBeDefined();
    expect(session!.model).toBe("claude-sonnet-4.6");
    expect(session!.modelProvider).toBe("anthropic");
  });

  it("updates session model for normal (non-heartbeat) runs", async () => {
    const { storePath, sessionKey } = await setup("claude-sonnet-4.6", "anthropic");

    // Normal run: model fields are passed through
    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: { input: 200, output: 100 },
      modelUsed: "gpt-5.2",
      providerUsed: "openai",
      contextTokensUsed: 128_000,
    });

    const session = readSessionModel(storePath, sessionKey);
    expect(session).toBeDefined();
    expect(session!.model).toBe("gpt-5.2");
    expect(session!.modelProvider).toBe("openai");
  });

  it("preserves model when heartbeat has usage but no model override", async () => {
    const { storePath, sessionKey } = await setup("claude-sonnet-4.6", "anthropic");

    // Heartbeat without model override: modelUsed/providerUsed are omitted
    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: { input: 50, output: 20 },
      modelUsed: undefined,
      providerUsed: undefined,
      contextTokensUsed: 4096,
    });

    const session = readSessionModel(storePath, sessionKey);
    expect(session).toBeDefined();
    expect(session!.model).toBe("claude-sonnet-4.6");
    expect(session!.modelProvider).toBe("anthropic");
  });
});
