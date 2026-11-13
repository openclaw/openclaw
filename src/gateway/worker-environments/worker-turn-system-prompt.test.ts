import { describe, expect, it } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  buildWorkerSystemPromptRouteKey,
  prepareWorkerSessionSystemPrompt,
} from "./worker-turn-system-prompt.js";

const model = { provider: "fake", id: "model", api: "openai-completions", baseUrl: "http://fake" };
const write = <T>(operation: () => Promise<T>) => operation();
const prompt = (rules: string) =>
  `You are an assistant.\n\n## Rules\n${rules}\n\n## Tools\n- read\n`;

async function runTurn(
  manager: SessionManager,
  sessionId: string,
  systemPrompt: string,
  routeKey = buildWorkerSystemPromptRouteKey({ model }),
) {
  const pin = await prepareWorkerSessionSystemPrompt({
    sessionId,
    manager,
    routeKey,
    systemPrompt,
    history: [],
    write,
  });
  await pin.persistUpdate();
  await manager.appendMessageAsync({ role: "user", content: "hi", timestamp: 0 });
  await pin.commit(manager, write);
  return { systemPrompt: pin.systemPrompt, update: pin.update, status: pin.seriesStatus };
}

describe("worker session system prompt", () => {
  it("keeps the first prefix and appends later changes as a delta", async () => {
    const manager = SessionManager.inMemory("/tmp/worker-pin");
    const sessionId = "worker-pin-delta";
    const first = await runTurn(manager, sessionId, prompt("- Be brief."));
    expect(first).toMatchObject({ systemPrompt: prompt("- Be brief."), status: "restarted:new" });
    expect(first.update).toBeUndefined();

    const second = await runTurn(manager, sessionId, prompt("- Prefer bullets."));
    expect(second.status).toBe("pinned");
    expect(second.systemPrompt).toBe(prompt("- Be brief."));
    expect(String(second.update?.content)).toContain("## Rules\n- Prefer bullets.");
    expect(String(second.update?.content)).not.toContain("## Tools");

    // The checkpoint records the latest rendering, so an unchanged turn sends no new delta.
    const third = await runTurn(manager, sessionId, prompt("- Prefer bullets."));
    expect(third).toMatchObject({ systemPrompt: prompt("- Be brief."), status: "pinned" });
    expect(third.update).toBeUndefined();
  });

  it("rebuilds the prefix at a model change", async () => {
    const manager = SessionManager.inMemory("/tmp/worker-pin");
    const sessionId = "worker-pin-route";
    await runTurn(manager, sessionId, prompt("- Be brief."));
    const switched = await runTurn(
      manager,
      sessionId,
      prompt("- Prefer bullets."),
      buildWorkerSystemPromptRouteKey({ model: { ...model, id: "other" } }),
    );
    expect(switched).toMatchObject({
      systemPrompt: prompt("- Prefer bullets."),
      status: "restarted:route:model",
    });
  });

  it("writes no checkpoint when the worker turn does not commit", async () => {
    const manager = SessionManager.inMemory("/tmp/worker-pin");
    const sessionId = "worker-pin-failed";
    {
      const pin = await prepareWorkerSessionSystemPrompt({
        sessionId,
        manager,
        routeKey: buildWorkerSystemPromptRouteKey({ model }),
        systemPrompt: prompt("- Be brief."),
        history: [],
        write,
      });
      expect(pin.systemPrompt).toBe(prompt("- Be brief."));
    }
    expect(manager.getEntries().filter((entry) => entry.type === "custom")).toEqual([]);
  });
});
