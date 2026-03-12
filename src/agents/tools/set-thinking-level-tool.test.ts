import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore, resolveStorePath, updateSessionStore } from "../../config/sessions.js";
import { createSetThinkingLevelTool } from "./set-thinking-level-tool.js";

function createThinkingState(params?: {
  defaultLevel?: ThinkLevel;
  sessionLevel?: ThinkLevel;
  turnLevel?: ThinkLevel;
}) {
  const state = {
    defaultLevel: params?.defaultLevel ?? "off",
    sessionLevel: params?.sessionLevel,
    turnLevel: params?.turnLevel,
  };
  return {
    state,
    getCurrent: () => state.turnLevel ?? state.sessionLevel ?? state.defaultLevel,
    setForScope: (scope: "turn" | "session", level: ThinkLevel) => {
      if (scope === "turn") {
        state.turnLevel = level;
        return;
      }
      state.sessionLevel = level;
      state.turnLevel = undefined;
    },
  };
}

async function createSessionFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-set-thinking-"));
  const cfg = {
    session: {
      store: path.join(root, "sessions-{agentId}.json"),
    },
  } as OpenClawConfig;
  const sessionKey = "agent:main:main";
  const storePath = resolveStorePath(cfg.session?.store, { agentId: "main" });
  await updateSessionStore(storePath, (store) => {
    store[sessionKey] = { sessionId: "sess-1", updatedAt: Date.now(), thinkingLevel: "low" };
  });
  return { root, cfg, sessionKey, storePath };
}

describe("set_thinking_level tool", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("updates only the current run for scope=turn", async () => {
    const fixture = await createSessionFixture();
    tempRoots.push(fixture.root);
    const thinking = createThinkingState({ defaultLevel: "off", sessionLevel: "low" });
    const applied: string[] = [];
    const tool = createSetThinkingLevelTool({
      agentSessionKey: fixture.sessionKey,
      config: fixture.cfg,
      provider: "openai",
      modelId: "gpt-5",
      getRequestedThinkingLevel: thinking.getCurrent,
      setRequestedThinkingLevelForScope: thinking.setForScope,
      applyEffectiveThinkingLevel: (level) => applied.push(level),
      reasoningSupported: true,
    });

    const result = await tool.execute("call-1", {
      level: "Adaptive",
      scope: "turn",
    });

    expect(result.details).toMatchObject({
      ok: true,
      priorRequestedLevel: "low",
      currentRequestedLevel: "adaptive",
      effectiveLevel: "medium",
      scope: "turn",
      persisted: false,
      explanation: "Adaptive thinking is not supported natively; using medium instead.",
    });
    expect(thinking.state.turnLevel).toBe("adaptive");
    expect(thinking.state.sessionLevel).toBe("low");
    expect(applied).toEqual(["medium"]);
    expect(
      loadSessionStore(fixture.storePath, { skipCache: true })[fixture.sessionKey]?.thinkingLevel,
    ).toBe("low");
  });

  it("persists scope=session and updates the current run immediately", async () => {
    const fixture = await createSessionFixture();
    tempRoots.push(fixture.root);
    const thinking = createThinkingState({
      defaultLevel: "off",
      sessionLevel: "low",
      turnLevel: "minimal",
    });
    const applied: string[] = [];
    const tool = createSetThinkingLevelTool({
      agentSessionKey: fixture.sessionKey,
      config: fixture.cfg,
      provider: "openai",
      modelId: "gpt-5",
      getRequestedThinkingLevel: thinking.getCurrent,
      setRequestedThinkingLevelForScope: thinking.setForScope,
      applyEffectiveThinkingLevel: (level) => applied.push(level),
      reasoningSupported: true,
    });

    const result = await tool.execute("call-2", {
      level: "high",
      scope: "session",
    });

    expect(result.details).toMatchObject({
      ok: true,
      priorRequestedLevel: "minimal",
      currentRequestedLevel: "high",
      effectiveLevel: "high",
      scope: "session",
      persisted: true,
      explanation: undefined,
    });
    expect(thinking.state.sessionLevel).toBe("high");
    expect(thinking.state.turnLevel).toBeUndefined();
    expect(applied).toEqual(["high"]);
    expect(
      loadSessionStore(fixture.storePath, { skipCache: true })[fixture.sessionKey]?.thinkingLevel,
    ).toBe("high");
  });

  it("persists through normalized session-store keys", async () => {
    const fixture = await createSessionFixture();
    tempRoots.push(fixture.root);
    const legacySessionKey = "Agent:Main:Main";
    await updateSessionStore(fixture.storePath, (store) => {
      delete store[fixture.sessionKey];
      store[legacySessionKey] = {
        sessionId: "sess-legacy",
        updatedAt: Date.now(),
        thinkingLevel: "minimal",
        label: "Legacy Session",
      };
    });
    const thinking = createThinkingState({ defaultLevel: "off", sessionLevel: "minimal" });
    const tool = createSetThinkingLevelTool({
      agentSessionKey: legacySessionKey,
      config: fixture.cfg,
      provider: "openai",
      modelId: "gpt-5",
      getRequestedThinkingLevel: thinking.getCurrent,
      setRequestedThinkingLevelForScope: thinking.setForScope,
      reasoningSupported: true,
    });

    await tool.execute("call-legacy", {
      level: "high",
      scope: "session",
    });

    const store = loadSessionStore(fixture.storePath, { skipCache: true });
    expect(store[legacySessionKey]).toBeUndefined();
    expect(store[fixture.sessionKey]).toMatchObject({
      sessionId: "sess-legacy",
      thinkingLevel: "high",
      label: "Legacy Session",
    });
  });

  it("rejects session scope when there is no active agent session", async () => {
    const thinking = createThinkingState({ defaultLevel: "off", sessionLevel: "low" });
    const tool = createSetThinkingLevelTool({
      provider: "openai",
      modelId: "gpt-5",
      getRequestedThinkingLevel: thinking.getCurrent,
      setRequestedThinkingLevelForScope: thinking.setForScope,
      reasoningSupported: true,
    });

    await expect(
      tool.execute("call-3", {
        level: "high",
        scope: "session",
      }),
    ).rejects.toThrow(/session scope requires an active agent session/i);
  });

  it("persists the requested level but applies effective off when reasoning is unsupported", async () => {
    const fixture = await createSessionFixture();
    tempRoots.push(fixture.root);
    const thinking = createThinkingState({ defaultLevel: "off", sessionLevel: "low" });
    const applied: string[] = [];
    const tool = createSetThinkingLevelTool({
      agentSessionKey: fixture.sessionKey,
      config: fixture.cfg,
      provider: "openai",
      modelId: "gpt-5",
      getRequestedThinkingLevel: thinking.getCurrent,
      setRequestedThinkingLevelForScope: thinking.setForScope,
      applyEffectiveThinkingLevel: (level) => applied.push(level),
      reasoningSupported: false,
    });

    const result = await tool.execute("call-4", {
      level: "high",
      scope: "session",
    });

    expect(result.details).toMatchObject({
      ok: true,
      priorRequestedLevel: "low",
      currentRequestedLevel: "high",
      effectiveLevel: "off",
      scope: "session",
      persisted: true,
      explanation: "Reasoning is not supported for this model.",
    });

    expect(thinking.getCurrent()).toBe("high");
    expect(applied).toEqual(["off"]);
    expect(
      loadSessionStore(fixture.storePath, { skipCache: true })[fixture.sessionKey]?.thinkingLevel,
    ).toBe("high");
  });
});
