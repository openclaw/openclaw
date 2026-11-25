import { describe, expect, it } from "vitest";
import {
  readHumanMentions,
  trimHumanMentions,
  updateHumanMentions,
  withHumanMentionEdit,
} from "./human-mentions.ts";

describe("human mention text ownership", () => {
  const alex = { profileId: "profile-alex", start: 0, end: 5 };

  it.each([
    ["@Alex!", [alex]],
    ["@Alexa", []],
    ["email@Alex", []],
  ])("keeps only the selected visible token after editing to %j", (next, expected) => {
    expect(updateHumanMentions("@Alex", next, [alex])).toEqual(expected);
  });

  it("deletes the actual selected occurrence when two people share a label", () => {
    const otherAlex = { profileId: "another-alex", start: 6, end: 11 };
    const previous = "@Alex @Alex";
    const input = { value: previous, start: 0, end: 6, inputType: "deleteContentBackward" };
    expect(updateHumanMentions(previous, "@Alex", [alex, otherAlex], input)).toEqual([
      { ...otherAlex, start: 0, end: 5 },
    ]);
    // Undo/programmatic edits with no exact range must not guess a same-name identity.
    expect(updateHumanMentions(previous, "@Alex", [alex, otherAlex])).toEqual([]);
  });

  it("invalidates a selected token replaced with identical pasted text", () => {
    expect(
      updateHumanMentions("@Alex", "@Alex", [alex], {
        value: "@Alex",
        start: 0,
        end: 5,
        inputType: "insertFromPaste",
      }),
    ).toEqual([]);
  });

  it("keeps mapped identities for an ordinary edit but applies a supplied replacement", () => {
    const previous = "@Alex x @Alex";
    const next = "@Alex y @Alex";
    const later = { profileId: "another-alex", start: 8, end: 13 };
    const input = { value: previous, start: 6, end: 7, inputType: "insertText" };
    const merged = withHumanMentionEdit(next, undefined, input, () =>
      updateHumanMentions(previous, next, [alex, later]),
    );
    expect(merged).toEqual([alex, later]);
    expect(merged[0]).toBe(alex);
    // A later span still gets its mapped copy when the edit has zero length delta.
    expect(merged[1]).not.toBe(later);
    expect(
      withHumanMentionEdit(next, [], input, () =>
        updateHumanMentions(previous, next, [alex, later]),
      ),
    ).toEqual([]);
    expect(
      withHumanMentionEdit("other text", [], input, () =>
        updateHumanMentions(previous, next, [alex, later], input),
      ),
    ).toEqual([alex, later]);
  });

  it("normalizes submission whitespace without changing UTF-16 recipient positions", () => {
    const mentions = [{ ...alex, start: 5, end: 10 }];
    const result = trimHumanMentions("  🦞 @Alex  ", mentions);
    expect(result).toEqual({ text: "🦞 @Alex", mentions: [{ ...alex, start: 3, end: 8 }] });
    expect(result.mentions?.[0]).not.toBe(mentions[0]);
    expect(trimHumanMentions(result.text, result.mentions)).toEqual(result);
  });

  it.for([
    [{ ...alex, start: -1 }],
    [{ ...alex, end: 99 }],
    [alex, alex],
    [{ ...alex, profileId: "" }],
    [{ ...alex, start: 1 }],
    Array.from({ length: 11 }, (_, index) => ({
      ...alex,
      start: index * 6,
      end: index * 6 + 5,
    })),
  ])("does not restore invalid recipient metadata %j", (mentions) => {
    const text = mentions.length === 11 ? "@Alex ".repeat(11).trimEnd() : "@Alex";
    expect(readHumanMentions(text, mentions)).toBeUndefined();
    if (mentions.length === 11) {
      const allowed = mentions.slice(0, 10);
      expect(readHumanMentions(text, allowed)).toEqual(allowed);
    }
  });

  it.each([
    [9, false],
    [32, true],
  ] as const)(
    "rejects only C0 controls when restoring a token (code unit %i)",
    (code, accepted) => {
      const text = `@Al${String.fromCharCode(code)}ex`;
      const mentions = [{ ...alex, end: text.length }];
      expect(readHumanMentions(text, mentions)).toEqual(accepted ? mentions : undefined);
    },
  );
});
