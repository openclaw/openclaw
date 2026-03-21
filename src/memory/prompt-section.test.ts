import { describe, it, expect, beforeEach } from "vitest";
import {
  registerMemoryPromptSection,
  buildMemoryPromptSection,
  clearMemoryPromptSection,
  _resetMemoryPromptSection,
} from "./prompt-section.js";

describe("memory prompt section registry", () => {
  beforeEach(() => {
    _resetMemoryPromptSection();
  });

  it("returns empty array when no builder is registered", () => {
    const result = buildMemoryPromptSection({
      availableTools: new Set(["memory_search", "memory_get"]),
    });
    expect(result).toEqual([]);
  });

  it("delegates to the registered builder", () => {
    registerMemoryPromptSection(({ availableTools }) => {
      if (!availableTools.has("memory_search")) {
        return [];
      }
      return ["## Custom Memory", "Use custom memory tools.", ""];
    });

    const result = buildMemoryPromptSection({
      availableTools: new Set(["memory_search"]),
    });
    expect(result).toEqual(["## Custom Memory", "Use custom memory tools.", ""]);
  });

  it("passes citationsMode to the builder", () => {
    registerMemoryPromptSection(({ citationsMode }) => {
      return [`citations: ${citationsMode ?? "default"}`];
    });

    expect(
      buildMemoryPromptSection({
        availableTools: new Set(),
        citationsMode: "off",
      }),
    ).toEqual(["citations: off"]);
  });

  it("last registration wins", () => {
    registerMemoryPromptSection(() => ["first"]);
    registerMemoryPromptSection(() => ["second"]);

    const result = buildMemoryPromptSection({ availableTools: new Set() });
    expect(result).toEqual(["second"]);
  });

  it("clearMemoryPromptSection resets the builder", () => {
    registerMemoryPromptSection(() => ["stale section"]);
    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual(["stale section"]);

    clearMemoryPromptSection();

    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([]);
  });
});
