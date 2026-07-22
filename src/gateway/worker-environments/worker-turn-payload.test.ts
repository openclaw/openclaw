import { describe, expect, it } from "vitest";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { assertSupportedTurn } from "./worker-turn-payload.js";

describe("assertSupportedTurn", () => {
  it("rejects scheduled authority before cloud-worker handoff", () => {
    expect(() =>
      assertSupportedTurn({
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        prompt: "run",
        timeoutMs: 1_000,
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        toolsAllow: ["write"],
        scheduledToolPolicy: { ownerSessionKey: "agent:main:discord:group:ops" },
      } as SessionPlacementTurnParams),
    ).toThrow("Cloud worker turns do not yet preserve scheduled tool policy");
  });
});
