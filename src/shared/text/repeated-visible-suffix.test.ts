import { describe, expect, it } from "vitest";
import {
  collapseRepeatedVisibleSuffixAfterDelimiter,
  extractStructuredRepeatedVisibleSuffix,
  findExplicitSingleTargetLiteralInPreamble,
} from "./repeated-visible-suffix.js";

describe("findExplicitSingleTargetLiteralInPreamble", () => {
  it("ignores apostrophes inside ordinary prose", () => {
    const input =
      "The user's exact target can't change. I must reply with exactly abc-123 and nothing else. This is a direct instruction for the output content.";

    expect(findExplicitSingleTargetLiteralInPreamble(input)).toBeNull();
  });

  it("still finds a real quoted target when apostrophes appear elsewhere in the preamble", () => {
    const input =
      "The user's exact target can't change. I must reply with exactly \"abc-123\" and nothing else. This is a direct instruction for the output content.";

    expect(findExplicitSingleTargetLiteralInPreamble(input)).toBe("abc-123");
  });
});

describe("collapseRepeatedVisibleSuffixAfterDelimiter", () => {
  it("collapses a repeated suffix even when the visible text starts with a space", () => {
    const prefix = [
      'The user is instructing me to reply with exactly "abc-123" and nothing else.',
      "This is a direct instruction for the output content.",
      "I must adhere to the instruction precisely.",
      "I will output the text directly as the final response.",
      "<channel|>",
    ].join("\n");

    expect(collapseRepeatedVisibleSuffixAfterDelimiter(prefix, " abc-123abc-123")).toBe(" abc-123");
  });
});

describe("extractStructuredRepeatedVisibleSuffix", () => {
  it("prefers the minimal repeated unit when runaway text repeats a mistakenly doubled exact target", () => {
    const input = [
      "The user is instructing me to reply with a very specific string: `pr68986-live-1776657289pr68986-live-1776657289` and nothing else.",
      "This is a direct instruction for the output content.",
      "I must adhere to the instruction precisely.",
      "I will output the text directly as the final response, as per the general instruction to reply in the current session.pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-177",
    ].join("\n");

    expect(extractStructuredRepeatedVisibleSuffix(input)).toBe("pr68986-live-1776657289");
  });

  it("does not collapse a duplicated sample that appears before later explanation", () => {
    const input = [
      'The user asked me to reply with exactly "Hello." and nothing else.',
      "This is only an explanation of the failure and not hidden planning.",
      "Here is a duplicated sample in the middle: Hello.Hello.Hello.",
      "Later I explain what happened in plain prose.",
    ].join("\n");

    expect(extractStructuredRepeatedVisibleSuffix(input)).toBe(input);
  });
});
