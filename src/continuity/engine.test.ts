import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { ContinuityContextEngine } from "./engine.js";
import type { ContinuityService } from "./service.js";

function makeMessage(text: string, role: "user" | "assistant" = "user"): AgentMessage {
  return {
    role,
    content: text,
    timestamp: Date.now(),
  } as AgentMessage;
}

function makeService() {
  return {
    buildSystemPromptAddition: vi.fn(),
    captureTurn: vi.fn(),
  } as unknown as ContinuityService & {
    buildSystemPromptAddition: ReturnType<typeof vi.fn>;
    captureTurn: ReturnType<typeof vi.fn>;
  };
}

describe("ContinuityContextEngine", () => {
  it("reports lazy bootstrap behavior and a no-op ingest path", async () => {
    const engine = new ContinuityContextEngine(makeService());

    await expect(
      engine.bootstrap({
        sessionId: "session-bootstrap",
        sessionKey: "main",
        sessionFile: "/tmp/session.jsonl",
      }),
    ).resolves.toEqual({
      bootstrapped: false,
      reason: "continuity bootstraps lazily",
    });

    await expect(
      engine.ingest({
        sessionId: "session-ingest",
        message: makeMessage("noop"),
      }),
    ).resolves.toEqual({ ingested: false });
  });

  it("delegates prompt assembly to the continuity service", async () => {
    const service = makeService();
    service.buildSystemPromptAddition.mockResolvedValue("<continuity>context</continuity>");
    const messages = [makeMessage("What do I prefer?")];
    const engine = new ContinuityContextEngine(service, "alpha");

    await expect(
      engine.assemble({
        sessionId: "session-assemble",
        sessionKey: "discord:direct:bob",
        messages,
      }),
    ).resolves.toEqual({
      messages,
      estimatedTokens: 0,
      systemPromptAddition: "<continuity>context</continuity>",
    });

    expect(service.buildSystemPromptAddition).toHaveBeenCalledWith({
      agentId: "alpha",
      sessionKey: "discord:direct:bob",
      messages,
    });
  });

  it("skips capture when there is no session key or no new turn slice", async () => {
    const service = makeService();
    const engine = new ContinuityContextEngine(service, "alpha");

    await engine.afterTurn({
      sessionId: "session-no-key",
      sessionFile: "/tmp/session.jsonl",
      messages: [makeMessage("previous")],
      prePromptMessageCount: 0,
    });
    await engine.afterTurn({
      sessionId: "session-no-new",
      sessionKey: "main",
      sessionFile: "/tmp/session.jsonl",
      messages: [makeMessage("previous")],
      prePromptMessageCount: 1,
    });
    await engine.afterTurn({
      sessionId: "session-heartbeat",
      sessionKey: "main",
      sessionFile: "/tmp/session.jsonl",
      messages: [makeMessage("heartbeat message")],
      prePromptMessageCount: 0,
      isHeartbeat: true,
    });

    expect(service.captureTurn).not.toHaveBeenCalled();
  });

  it("captures only the new turn slice after the prompt boundary", async () => {
    const service = makeService();
    service.captureTurn.mockResolvedValue([]);
    const engine = new ContinuityContextEngine(service, "alpha");
    const messages = [
      makeMessage("previous user"),
      makeMessage("previous assistant", "assistant"),
      makeMessage("I prefer terse status updates."),
      makeMessage("I will follow up tomorrow.", "assistant"),
    ];

    await engine.afterTurn({
      sessionId: "session-slice",
      sessionKey: "main",
      sessionFile: "/tmp/session.jsonl",
      messages,
      prePromptMessageCount: 2,
    });

    expect(service.captureTurn).toHaveBeenCalledWith({
      agentId: "alpha",
      sessionId: "session-slice",
      sessionKey: "main",
      messages: messages.slice(2),
    });
  });

  it("falls back to trailing turn messages when compaction invalidates the pre-prompt boundary", async () => {
    const service = makeService();
    service.captureTurn.mockResolvedValue([]);
    const engine = new ContinuityContextEngine(service, "alpha");
    const compactedMessages = [
      makeMessage("Compaction summary", "assistant"),
      makeMessage("I prefer compact status updates."),
      makeMessage("Acknowledged.", "assistant"),
    ];

    await engine.afterTurn({
      sessionId: "session-compacted",
      sessionKey: "main",
      sessionFile: "/tmp/session.jsonl",
      messages: compactedMessages,
      prePromptMessageCount: 50,
    });

    expect(service.captureTurn).toHaveBeenCalledWith({
      agentId: "alpha",
      sessionId: "session-compacted",
      sessionKey: "main",
      messages: compactedMessages.slice(1),
    });
  });

  it("delegates compact and dispose to the legacy engine", async () => {
    const service = makeService();
    const engine = new ContinuityContextEngine(service);
    const legacy = (
      engine as unknown as {
        legacy: {
          compact: (params: unknown) => Promise<unknown>;
          dispose: () => Promise<void>;
        };
      }
    ).legacy;
    const compactResult = {
      ok: true,
      compacted: true,
      result: { tokensBefore: 10, tokensAfter: 5 },
    };
    const compactSpy = vi.spyOn(legacy, "compact").mockResolvedValue(compactResult);
    const disposeSpy = vi.spyOn(legacy, "dispose").mockResolvedValue();
    const params = {
      sessionId: "session-compact",
      sessionKey: "main",
      sessionFile: path.join("/tmp", "session.jsonl"),
      force: true,
      currentTokenCount: 10,
      compactionTarget: "budget" as const,
      legacyParams: { workspaceDir: "/tmp" },
    };

    await expect(engine.compact(params)).resolves.toEqual(compactResult);
    expect(compactSpy).toHaveBeenCalledWith(params);

    await engine.dispose();
    expect(disposeSpy).toHaveBeenCalledOnce();
  });
});
