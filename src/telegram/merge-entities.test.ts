import type { MessageEntity } from "@grammyjs/types";
import { describe, expect, it } from "vitest";
import { mergeFragmentEntities } from "./merge-entities.js";

describe("mergeFragmentEntities", () => {
  it("returns undefined when no fragments have entities", () => {
    const result = mergeFragmentEntities([{ text: "hello " }, { text: "world" }]);
    expect(result).toBeUndefined();
  });

  it("preserves entities from a single fragment", () => {
    const entities: MessageEntity[] = [{ type: "bold", offset: 0, length: 5 }];
    const result = mergeFragmentEntities([{ text: "hello", entities }]);
    expect(result).toEqual([{ type: "bold", offset: 0, length: 5 }]);
  });

  it("adjusts offsets for entities in subsequent fragments (no separator)", () => {
    const result = mergeFragmentEntities([
      {
        text: "Hello ",
        entities: [{ type: "bold", offset: 0, length: 5 }],
      },
      {
        text: "world!",
        entities: [{ type: "italic", offset: 0, length: 5 }],
      },
    ]);
    expect(result).toEqual([
      { type: "bold", offset: 0, length: 5 },
      { type: "italic", offset: 6, length: 5 },
    ]);
  });

  it("adjusts offsets accounting for newline separator", () => {
    const result = mergeFragmentEntities(
      [
        {
          text: "line one",
          entities: [{ type: "bold", offset: 0, length: 4 }],
        },
        {
          text: "line two",
          entities: [{ type: "italic", offset: 5, length: 3 }],
        },
      ],
      "\n",
    );
    // "line one\nline two" - fragment B offset 0 maps to global offset 9
    expect(result).toEqual([
      { type: "bold", offset: 0, length: 4 },
      { type: "italic", offset: 14, length: 3 }, // 8 (len "line one") + 1 ("\n") + 5
    ]);
  });

  it("preserves bot_mention entities across fragments", () => {
    const result = mergeFragmentEntities([
      {
        text: "Hey ",
        entities: [],
      },
      {
        text: "@mybot do something",
        entities: [
          {
            type: "mention",
            offset: 0,
            length: 6,
          },
        ],
      },
    ]);
    expect(result).toEqual([{ type: "mention", offset: 4, length: 6 }]);
  });

  it("handles fragments with no entities interspersed", () => {
    const result = mergeFragmentEntities([
      {
        text: "aaa",
        entities: [{ type: "bold", offset: 0, length: 3 }],
      },
      { text: "bbb" },
      {
        text: "ccc",
        entities: [{ type: "code", offset: 0, length: 3 }],
      },
    ]);
    expect(result).toEqual([
      { type: "bold", offset: 0, length: 3 },
      { type: "code", offset: 6, length: 3 },
    ]);
  });

  it("handles empty text fragments without breaking offsets", () => {
    const result = mergeFragmentEntities([
      { text: "abc", entities: [{ type: "bold", offset: 0, length: 3 }] },
      { text: "" },
      { text: "def", entities: [{ type: "italic", offset: 0, length: 3 }] },
    ]);
    expect(result).toEqual([
      { type: "bold", offset: 0, length: 3 },
      { type: "italic", offset: 3, length: 3 },
    ]);
  });

  it("does not add separator for empty text fragments", () => {
    const result = mergeFragmentEntities(
      [
        { text: "abc", entities: [{ type: "bold", offset: 0, length: 3 }] },
        { text: "" },
        { text: "def", entities: [{ type: "italic", offset: 0, length: 3 }] },
      ],
      "\n",
    );
    // empty fragment is skipped for separator, so: "abc" + "\n" + "def"
    // "def" starts at offset 4 (3 + 1)
    expect(result).toEqual([
      { type: "bold", offset: 0, length: 3 },
      { type: "italic", offset: 4, length: 3 },
    ]);
  });

  it("returns undefined for empty fragment list", () => {
    expect(mergeFragmentEntities([])).toBeUndefined();
  });

  it("preserves extra entity fields like url and user", () => {
    const user = { id: 123, is_bot: true, first_name: "Bot" };
    const result = mergeFragmentEntities([
      { text: "check " },
      {
        text: "this link",
        entities: [
          {
            type: "text_link",
            offset: 0,
            length: 9,
            url: "https://example.com",
          } as MessageEntity,
        ],
      },
      {
        text: " from @bot",
        entities: [
          {
            type: "text_mention",
            offset: 6,
            length: 4,
            user,
          } as MessageEntity,
        ],
      },
    ]);
    expect(result).toEqual([
      {
        type: "text_link",
        offset: 6,
        length: 9,
        url: "https://example.com",
      },
      {
        type: "text_mention",
        offset: 21,
        length: 4,
        user,
      },
    ]);
  });
});
