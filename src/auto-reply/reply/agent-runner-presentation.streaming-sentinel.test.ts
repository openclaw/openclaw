// Covers sentinel stripping on the partial streaming/draft delivery path (#103735).
import { describe, expect, it } from "vitest";
import type { ReplyPayload } from "../types.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import { createAgentTurnPresentation } from "./agent-runner-presentation.js";
import type { ReplyMediaContext } from "./reply-media-paths.js";

function buildPresentation() {
  return createAgentTurnPresentation({
    turn: {
      followupRun: { run: { silentExpected: false } },
      isHeartbeat: false,
      typingSignals: { signalTextDelta: async () => {} },
    } as unknown as AgentTurnParams,
    replyMediaContext: {} as ReplyMediaContext,
    directlySentBlockKeys: new Set<string>(),
    directlySentBlockPayloads: [],
    heartbeatState: { didLogStrip: false },
  });
}

function prepare(text: string): string | undefined {
  const payload: ReplyPayload = { text };
  return buildPresentation().preparePartialForTyping(payload);
}

describe("preparePartialForTyping NO_REPLY sentinel handling", () => {
  it("strips newline-separated leading NO_REPLY from partial updates (#103735)", () => {
    expect(prepare("NO_REPLY\n\nWait — the user")).toBe("Wait — the user");
    expect(prepare("NO_REPLY\nHere is the answer")).toBe("Here is the answer");
  });

  it("strips repeated newline-separated sentinels from partial updates", () => {
    expect(prepare("NO_REPLY\nNO_REPLY\n\nWait — the user")).toBe("Wait — the user");
  });

  it("still strips glued-attached tokens", () => {
    expect(prepare("NO_REPLYhello")).toBe("hello");
  });

  it("preserves single-space-separated natural-language text", () => {
    expect(prepare("NO_REPLY is the documented sentinel")).toBe(
      "NO_REPLY is the documented sentinel",
    );
  });

  it("suppresses exact and prefix-fragment sentinel drafts", () => {
    expect(prepare("NO_REPLY")).toBeUndefined();
    expect(prepare("NO_REPLY\n\n")).toBeUndefined();
    expect(prepare("NO_RE")).toBeUndefined();
  });
});
