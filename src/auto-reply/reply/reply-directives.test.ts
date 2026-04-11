import { describe, expect, it } from "vitest";
import { parseReplyDirectives } from "./reply-directives.js";

describe("parseReplyDirectives — [[buttons:...]] tag", () => {
  it("parses a simple yes/no button tag and strips it from text", () => {
    const raw =
      'Which option? [[buttons: [{"label":"Yes","value":"yes","style":"success"},{"label":"No","value":"no","style":"danger"}]]]';
    const result = parseReplyDirectives(raw);
    expect(result.text).toBe("Which option?");
    expect(result.interactive).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Yes", value: "yes", style: "success" },
            { label: "No", value: "no", style: "danger" },
          ],
        },
      ],
    });
  });

  it("parses buttons with no style field", () => {
    const raw = 'Pick one [[buttons: [{"label":"A","value":"a"},{"label":"B","value":"b"}]]]';
    const result = parseReplyDirectives(raw);
    expect(result.text).toBe("Pick one");
    expect(result.interactive?.blocks[0]).toMatchObject({
      type: "buttons",
      buttons: [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ],
    });
  });

  it("strips the tag from the middle of text", () => {
    const raw = 'Before [[buttons: [{"label":"X","value":"x"}]]] after';
    const result = parseReplyDirectives(raw);
    expect(result.text).toBe("Before after");
    expect(result.interactive).toBeDefined();
  });

  it("strips the tag from the start of text", () => {
    const raw = '[[buttons: [{"label":"Go","value":"go"}]]] Some text';
    const result = parseReplyDirectives(raw);
    expect(result.text).toBe("Some text");
    expect(result.interactive).toBeDefined();
  });

  it("strips the tag from the end of text", () => {
    const raw = 'Some text [[buttons: [{"label":"Ok","value":"ok"}]]]';
    const result = parseReplyDirectives(raw);
    expect(result.text).toBe("Some text");
    expect(result.interactive).toBeDefined();
  });

  it("ignores invalid JSON and leaves text unchanged", () => {
    const raw = "Some text [[buttons: not-valid-json]]";
    const result = parseReplyDirectives(raw);
    // The tag didn't match the regex (not-valid-json doesn't start with [), text unchanged
    expect(result.text).toBe("Some text [[buttons: not-valid-json]]");
    expect(result.interactive).toBeUndefined();
  });

  it("returns undefined interactive when no buttons tag is present", () => {
    const result = parseReplyDirectives("Plain reply text with no tags");
    expect(result.interactive).toBeUndefined();
    expect(result.text).toBe("Plain reply text with no tags");
  });

  it("uses the first valid buttons tag when multiple are present", () => {
    const raw =
      'First [[buttons: [{"label":"A","value":"a"}]]] second [[buttons: [{"label":"B","value":"b"}]]]';
    const result = parseReplyDirectives(raw);
    expect(result.interactive?.blocks[0]).toMatchObject({
      type: "buttons",
      buttons: [{ label: "A", value: "a" }],
    });
    // Both tags are stripped from the text
    expect(result.text).toBe("First second");
  });

  it("ignores buttons tags with empty arrays (normalizeInteractiveReply rejects empty blocks)", () => {
    const raw = "Text [[buttons: []]] more";
    const result = parseReplyDirectives(raw);
    expect(result.interactive).toBeUndefined();
    // Tag is NOT stripped when parsing fails (interactive remains undefined)
    expect(result.text).toContain("[[buttons: []]]");
  });

  it("tolerates whitespace variants inside the tag", () => {
    const raw = '[[ buttons : [{"label":"Ok","value":"ok"}] ]]';
    const result = parseReplyDirectives(raw);
    expect(result.interactive).toBeDefined();
    expect(result.text).toBe("");
  });

  it("coexists with [[reply_to_current]] tag", () => {
    const raw =
      '[[reply_to_current]] Email ready [[buttons: [{"label":"Send","value":"send","style":"success"},{"label":"Cancel","value":"cancel","style":"danger"}]]]';
    const result = parseReplyDirectives(raw, { currentMessageId: "msg-123" });
    expect(result.text).toBe("Email ready");
    expect(result.replyToCurrent).toBe(true);
    expect(result.interactive).toBeDefined();
    expect(result.interactive?.blocks[0]).toMatchObject({
      type: "buttons",
      buttons: [
        { label: "Send", value: "send", style: "success" },
        { label: "Cancel", value: "cancel", style: "danger" },
      ],
    });
  });

  it("three-button approval flow", () => {
    const raw =
      'Approve this exec? [[buttons: [{"label":"Allow Once","value":"/approve abc allow-once","style":"success"},{"label":"Allow Always","value":"/approve abc allow-always","style":"primary"},{"label":"Deny","value":"/approve abc deny","style":"danger"}]]]';
    const result = parseReplyDirectives(raw);
    expect(result.text).toBe("Approve this exec?");
    expect(result.interactive?.blocks[0]).toMatchObject({
      type: "buttons",
      buttons: [
        { label: "Allow Once", value: "/approve abc allow-once", style: "success" },
        { label: "Allow Always", value: "/approve abc allow-always", style: "primary" },
        { label: "Deny", value: "/approve abc deny", style: "danger" },
      ],
    });
  });
});
