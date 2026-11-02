import { describe, expect, it } from "vitest";
import { extractCompanionCommandQuestion } from "./companion-question.ts";

describe("companion selection questions", () => {
  it("extracts both Control UI command aliases", () => {
    expect(extractCompanionCommandQuestion("/btw what changed?")).toBe("what changed?");
    expect(extractCompanionCommandQuestion("/side: what changed?")).toBe("what changed?");
    expect(extractCompanionCommandQuestion("/btw")).toBe("");
  });
});
