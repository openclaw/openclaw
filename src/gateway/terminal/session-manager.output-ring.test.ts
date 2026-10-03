import { describe, expect, it, vi } from "vitest";
import { TerminalSessionManager } from "./session-manager.js";
import { baseOpenRequest, makeFakePty } from "./session-manager.test-helpers.js";

describe("TerminalSessionManager output ring", () => {
  it("bounds buffered output by evicting whole head chunks", async () => {
    const fake = makeFakePty();
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => fake,
      scrollbackChars: 8,
    });
    const outcome = await manager.open(baseOpenRequest());
    if (!outcome.ok) {
      throw new Error("expected open");
    }
    fake.emitData("abcd");
    fake.emitData("efgh");
    expect(manager.snapshot(outcome.sessionId)).toBe("abcdefgh");
    fake.emitData("ijkl");
    // Cap exceeded: the oldest whole chunk goes; boundaries stay intact.
    expect(manager.snapshot(outcome.sessionId)).toBe("efghijkl");

    for (let value = 0; value < 5_000; value += 1) {
      fake.emitData(String(value).padStart(4, "0"));
    }
    expect(manager.snapshot(outcome.sessionId)).toBe("49984999");
    expect(manager.attach("conn-2", outcome.sessionId)?.buffer).toBe("49984999");
    fake.emitData("tail");
    expect(manager.snapshot(outcome.sessionId)).toBe("4999tail");
  });

  it("keeps only the tail of a single oversized chunk", async () => {
    const fake = makeFakePty();
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => fake,
      scrollbackChars: 8,
    });
    const outcome = await manager.open(baseOpenRequest());
    if (!outcome.ok) {
      throw new Error("expected open");
    }
    fake.emitData("0123456789AB");
    expect(manager.snapshot(outcome.sessionId)).toBe("456789AB");
  });

  it("does not retain a leading lone low surrogate from an oversized chunk", async () => {
    const fake = makeFakePty();
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => fake,
      scrollbackChars: 3,
    });
    const outcome = await manager.open(baseOpenRequest());
    if (!outcome.ok) {
      throw new Error("expected open");
    }

    fake.emitData("ab😀cd");

    expect(manager.snapshot(outcome.sessionId)).toBe("cd");
  });

  it("returns undefined for unknown sessions", () => {
    const manager = new TerminalSessionManager({ emit: vi.fn() });
    expect(manager.snapshot("nope")).toBeUndefined();
  });
});
