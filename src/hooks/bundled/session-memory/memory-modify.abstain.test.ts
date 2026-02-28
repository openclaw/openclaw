import { describe, it, expect, vi, beforeEach } from "vitest";

// Switchable outcome for the decision override mock
let forcedOutcome: "ABSTAIN_CONFIRM" | "ABSTAIN_CLARIFY" = "ABSTAIN_CONFIRM";

// ---- Mock fs/promises without referencing top-level variables (Vitest hoisting-safe) ----
vi.mock("node:fs/promises", () => {
  const writeFile = vi.fn(async () => undefined);
  const readFile = vi.fn(async () => "");
  const mkdir = vi.fn(async () => undefined);

  return {
    default: {
      writeFile,
      readFile,
      mkdir,
    },
  };
});

// ---- Force ABSTAIN outcome (switchable) ----
vi.mock("../../../clarityburst/decision-override.js", () => ({
  applyMemoryModifyOverrides: async () => ({
    outcome: forcedOutcome,
    reason: forcedOutcome === "ABSTAIN_CLARIFY" ? "CLARIFY_REQUIRED" : "CONFIRM_REQUIRED",
    contractId: null,
    instructions:
      forcedOutcome === "ABSTAIN_CLARIFY"
        ? "Provide clarifying details for MEMORY_MODIFY"
        : "Use CONFIRM MEMORY_MODIFY <token>",
  }),
}));

import fs from "node:fs/promises";
import saveSessionToMemory from "./handler.js";

describe("MEMORY_MODIFY commit point - ABSTAIN behavior", () => {
  const writeFileMock = (fs as any).writeFile as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeFileMock.mockClear();
  });

  function makeEvent() {
    return {
      type: "command",
      action: "new",
      sessionKey: "test-session",
      timestamp: Date.now(),
      context: {
        previousSessionEntry: {},
        sessionEntry: {},
      },
      messages: [],
    } as any;
  }

  it("blocks persistent write and emits deterministic message on ABSTAIN_CONFIRM", async () => {
    forcedOutcome = "ABSTAIN_CONFIRM";
    const event = makeEvent();

    await saveSessionToMemory(event);

    expect(writeFileMock).not.toHaveBeenCalled();
    expect(event.messages.length).toBe(1);
    expect(event.messages[0]).toContain("[Blocked] MEMORY_MODIFY: CONFIRM_REQUIRED");
  });

  it("blocks persistent write and emits deterministic message on ABSTAIN_CLARIFY", async () => {
    forcedOutcome = "ABSTAIN_CLARIFY";
    const event = makeEvent();

    await saveSessionToMemory(event);

    expect(writeFileMock).not.toHaveBeenCalled();
    expect(event.messages.length).toBe(1);
    expect(event.messages[0]).toContain("[Blocked] MEMORY_MODIFY: CLARIFY_REQUIRED");
  });
});
