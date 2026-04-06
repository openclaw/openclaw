import { describe, expect, it } from "vitest";
import {
  appendUniqueVisibleTextSuffix,
  mergeAssistantVisibleText,
} from "./assistant-visible-text-merge.js";

describe("appendUniqueVisibleTextSuffix", () => {
  it("inserts a space when joining ASCII words", () => {
    expect(appendUniqueVisibleTextSuffix("Hello", "world")).toBe("Hello world");
  });

  it("does not add a space for CJK punctuation boundaries", () => {
    expect(appendUniqueVisibleTextSuffix("补充一个架构图：", "项目结构总结")).toBe(
      "补充一个架构图：项目结构总结",
    );
  });

  it("deduplicates overlapping suffix text", () => {
    expect(appendUniqueVisibleTextSuffix("Hello wor", "world")).toBe("Hello world");
  });
});

describe("mergeAssistantVisibleText", () => {
  it("keeps growing snapshots intact", () => {
    expect(mergeAssistantVisibleText("Hello", "Hello world")).toBe("Hello world");
  });

  it("keeps an already visible longer prefix when a later snapshot gets shorter", () => {
    expect(mergeAssistantVisibleText("补充一个架构图：", "项目结构总结")).toBe(
      "补充一个架构图：项目结构总结",
    );
  });
});
