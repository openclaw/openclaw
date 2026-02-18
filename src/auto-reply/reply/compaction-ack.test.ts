import { describe, expect, it } from "vitest";
import { isCompactionAck } from "./compaction-ack.js";

describe("isCompactionAck", () => {
  // Core variants
  it("accepts 'ok'", () => expect(isCompactionAck("ok")).toBe(true));
  it("accepts 'okay'", () => expect(isCompactionAck("okay")).toBe(true));
  it("accepts 'ok go'", () => expect(isCompactionAck("ok go")).toBe(true));
  it("accepts 'looks good'", () => expect(isCompactionAck("looks good")).toBe(true));
  it("accepts 'look good'", () => expect(isCompactionAck("look good")).toBe(true));
  it("accepts 'lgtm'", () => expect(isCompactionAck("lgtm")).toBe(true));
  it("accepts 'go ahead'", () => expect(isCompactionAck("go ahead")).toBe(true));
  it("accepts 'continue'", () => expect(isCompactionAck("continue")).toBe(true));
  it("accepts 'resume'", () => expect(isCompactionAck("resume")).toBe(true));
  it("accepts 'proceed'", () => expect(isCompactionAck("proceed")).toBe(true));
  it("accepts 'sure'", () => expect(isCompactionAck("sure")).toBe(true));
  it("accepts 'yes'", () => expect(isCompactionAck("yes")).toBe(true));
  it("accepts 'yep'", () => expect(isCompactionAck("yep")).toBe(true));
  it("accepts 'yup'", () => expect(isCompactionAck("yup")).toBe(true));
  it("accepts 'yeah'", () => expect(isCompactionAck("yeah")).toBe(true));
  it("accepts 'got it'", () => expect(isCompactionAck("got it")).toBe(true));
  it("accepts 'do it'", () => expect(isCompactionAck("do it")).toBe(true));

  // Case-insensitivity
  it("accepts 'OK' (uppercase)", () => expect(isCompactionAck("OK")).toBe(true));
  it("accepts 'OKAY' (uppercase)", () => expect(isCompactionAck("OKAY")).toBe(true));
  it("accepts 'Go Ahead' (mixed)", () => expect(isCompactionAck("Go Ahead")).toBe(true));
  it("accepts 'LGTM' (uppercase)", () => expect(isCompactionAck("LGTM")).toBe(true));

  // Whitespace trimming
  it("accepts '  ok  ' (padded)", () => expect(isCompactionAck("  ok  ")).toBe(true));
  it("accepts '  resume  ' (padded)", () => expect(isCompactionAck("  resume  ")).toBe(true));

  // Rejections — non-ack text should not trigger
  it("rejects 'no'", () => expect(isCompactionAck("no")).toBe(false));
  it("rejects 'nope'", () => expect(isCompactionAck("nope")).toBe(false));
  it("rejects 'skip'", () => expect(isCompactionAck("skip")).toBe(false));
  it("rejects 'do Q1'", () => expect(isCompactionAck("do Q1")).toBe(false));
  it("rejects 'do all'", () => expect(isCompactionAck("do all")).toBe(false));
  it("rejects 'skip all'", () => expect(isCompactionAck("skip all")).toBe(false));
  it("rejects empty string", () => expect(isCompactionAck("")).toBe(false));
  it("rejects arbitrary text", () => expect(isCompactionAck("what was I doing?")).toBe(false));
  it("rejects 'okay but wait'", () => expect(isCompactionAck("okay but wait")).toBe(false));
  it("rejects 'ok cool'", () => expect(isCompactionAck("ok cool")).toBe(false));
});
