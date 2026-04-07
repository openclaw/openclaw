import { describe, expect, it } from "vitest";
import { buildDeicticResolutionNote, isShortDeicticReference } from "./deictic-context.js";

describe("deictic context resolver", () => {
  it("detects direct referential expressions without requiring nearby structure", () => {
    expect(isShortDeicticReference("これどうなってるの")).toBe(true);
    expect(isShortDeicticReference("それお願い")).toBe(true);
    expect(isShortDeicticReference("this?")).toBe(true);
  });

  it("uses nearby conversation structure for ambiguous follow-up messages", () => {
    expect(isShortDeicticReference("進捗どう？")).toBe(false);
    expect(isShortDeicticReference("大丈夫？")).toBe(false);
    expect(isShortDeicticReference("その件")).toBe(false);

    expect(
      isShortDeicticReference("進捗どう？", {
        hasReplyTarget: true,
      }),
    ).toBe(true);
    expect(
      isShortDeicticReference("大丈夫？", {
        hasThreadHistory: true,
      }),
    ).toBe(true);
    expect(
      isShortDeicticReference("その件", {
        hasReplyTarget: true,
      }),
    ).toBe(true);
    expect(
      isShortDeicticReference("this issue", {
        hasThreadHistory: true,
      }),
    ).toBe(true);
  });

  it("does not overfire on vague text without direct reference or nearby structure", () => {
    expect(isShortDeicticReference("見てほしい")).toBe(false);
    expect(isShortDeicticReference("いけそう？")).toBe(false);
    expect(isShortDeicticReference("その修正案で進めたい")).toBe(false);
    expect(isShortDeicticReference("PDF Viewer 2 の MatrixTransform 修正どう進める？")).toBe(false);
  });

  it("builds nearby referent candidates from reply and thread context", () => {
    const note = buildDeicticResolutionNote({
      userText: "進捗どう？",
      replyToBody: "PRの説明文がまだ曖昧",
      threadHistoryBody: "直前: memory-coreのprompt修正だけでは不十分",
      threadStarterBody: "最初の話題",
    });

    expect(note).toContain("[Deictic reference resolver]");
    expect(note).toContain("1. replied message: PRの説明文がまだ曖昧");
    expect(note).toContain("2. thread history: 直前: memory-coreのprompt修正だけでは不十分");
    expect(note).toContain("3. thread starter: 最初の話題");
    expect(note).toContain("Multiple nearby candidates exist");
  });

  it("still emits a resolver note for direct referential expressions without nearby context", () => {
    const note = buildDeicticResolutionNote({
      userText: "this?",
    });

    expect(note).toContain("[Deictic reference resolver]");
    expect(note).toContain("primary candidate referents before using broader memory");
  });

  it("returns undefined for non-referential messages", () => {
    expect(
      buildDeicticResolutionNote({
        userText: "PDF Viewer 2 の MatrixTransform 修正どう進める？",
        threadHistoryBody: "something",
      }),
    ).toBeUndefined();
  });
});
