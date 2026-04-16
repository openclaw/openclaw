import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type ReplayToolCall = {
  type: unknown;
  name: unknown;
  arguments?: unknown;
};

function loadFixture(kind: "positive" | "negative"): unknown {
  const fixturePath = path.resolve(
    process.cwd(),
    `test/fixtures/claw-code-tool-call-replay-${kind}.json`,
  );
  return JSON.parse(readFileSync(fixturePath, "utf8"));
}

function assertReplayToolCallShape(entry: ReplayToolCall, index: number): void {
  expect(entry.type, `entry ${index} must use toolCall type`).toBe("toolCall");
  expect(typeof entry.name, `entry ${index} name must be a non-empty string`).toBe("string");
  expect((entry.name as string).trim().length, `entry ${index} name cannot be empty`).toBeGreaterThan(
    0,
  );
  if (entry.arguments !== undefined) {
    expect(
      entry.arguments && typeof entry.arguments === "object" && !Array.isArray(entry.arguments),
      `entry ${index} arguments must be an object when present`,
    ).toBe(true);
  }
}

describe("claw-code replay fixtures", () => {
  it("keeps positive fixture entries well-formed", () => {
    const payload = loadFixture("positive");
    expect(Array.isArray(payload)).toBe(true);
    const entries = payload as ReplayToolCall[];
    expect(entries.length).toBeGreaterThan(0);
    entries.forEach((entry, index) => assertReplayToolCallShape(entry, index));
  });

  it("keeps negative fixture entries well-formed", () => {
    const payload = loadFixture("negative");
    expect(Array.isArray(payload)).toBe(true);
    const entries = payload as ReplayToolCall[];
    expect(entries.length).toBeGreaterThan(0);
    entries.forEach((entry, index) => assertReplayToolCallShape(entry, index));
  });
});
