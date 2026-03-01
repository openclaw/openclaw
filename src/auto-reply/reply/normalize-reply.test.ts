import { describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../types.js";
import { normalizeReplyPayload, type NormalizeReplySkipReason } from "./normalize-reply.js";

describe("normalizeReplyPayload – [THINK] prefix filtering", () => {
  function normalize(text: string, media?: Partial<ReplyPayload>) {
    const onSkip = vi.fn<(reason: NormalizeReplySkipReason) => void>();
    const result = normalizeReplyPayload({ text, ...media }, { onSkip });
    return { result, onSkip };
  }

  it("suppresses text that is entirely a [THINK] block (no closing tag)", () => {
    const { result, onSkip } = normalize("[THINK] some internal reasoning");
    expect(result).toBeNull();
    expect(onSkip).toHaveBeenCalledWith("think");
  });

  it("suppresses [THINK] alone", () => {
    const { result, onSkip } = normalize("[THINK]");
    expect(result).toBeNull();
    expect(onSkip).toHaveBeenCalledWith("think");
  });

  it("strips think block and delivers content after [/THINK]", () => {
    const { result } = normalize("[THINK] reasoning here [/THINK] actual reply");
    expect(result).not.toBeNull();
    expect(result!.text).toBe("actual reply");
  });

  it("suppresses when [THINK]...[/THINK] has no content after", () => {
    const { result, onSkip } = normalize("[THINK] reasoning [/THINK]");
    expect(result).toBeNull();
    expect(onSkip).toHaveBeenCalledWith("think");
  });

  it("suppresses when [THINK]...[/THINK] has only whitespace after", () => {
    const { result, onSkip } = normalize("[THINK] reasoning [/THINK]   \n  ");
    expect(result).toBeNull();
    expect(onSkip).toHaveBeenCalledWith("think");
  });

  it("leaves normal text without think prefix unchanged", () => {
    const { result } = normalize("Normal text without think");
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Normal text without think");
  });

  it("leaves text with [THINK] not at start unchanged", () => {
    const { result } = normalize("Hello [THINK] this is mid-text");
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Hello [THINK] this is mid-text");
  });

  it("handles case insensitivity — [think]", () => {
    const { result, onSkip } = normalize("[think] some reasoning");
    expect(result).toBeNull();
    expect(onSkip).toHaveBeenCalledWith("think");
  });

  it("handles case insensitivity — [Think]", () => {
    const { result, onSkip } = normalize("[Think] some reasoning");
    expect(result).toBeNull();
    expect(onSkip).toHaveBeenCalledWith("think");
  });

  it("handles case insensitivity for closing tag — [think]...[/think]", () => {
    const { result } = normalize("[think] reasoning [/think] reply text");
    expect(result).not.toBeNull();
    expect(result!.text).toBe("reply text");
  });

  it("preserves media when think block covers all text", () => {
    const { result } = normalize("[THINK] reasoning", {
      mediaUrl: "file:///tmp/photo.jpg",
    });
    expect(result).not.toBeNull();
    // Text should be stripped but payload delivered because of media
    expect(result!.mediaUrl).toBe("file:///tmp/photo.jpg");
  });

  it("handles leading whitespace before [THINK]", () => {
    const { result, onSkip } = normalize("   [THINK] reasoning");
    expect(result).toBeNull();
    expect(onSkip).toHaveBeenCalledWith("think");
  });

  it("does not interfere with SILENT_REPLY_TOKEN behavior", () => {
    const { result, onSkip } = normalize("NO_REPLY");
    expect(result).toBeNull();
    expect(onSkip).toHaveBeenCalledWith("silent");
  });

  // [THINKING] variant tests
  it("suppresses text that is entirely a [THINKING] block (no closing tag)", () => {
    const { result, onSkip } = normalize("[THINKING] some internal reasoning");
    expect(result).toBeNull();
    expect(onSkip).toHaveBeenCalledWith("think");
  });

  it("suppresses [THINKING] alone", () => {
    const { result, onSkip } = normalize("[THINKING]");
    expect(result).toBeNull();
    expect(onSkip).toHaveBeenCalledWith("think");
  });

  it("strips thinking block and delivers content after [/THINKING]", () => {
    const { result } = normalize("[THINKING] reasoning here [/THINKING] actual reply");
    expect(result).not.toBeNull();
    expect(result!.text).toBe("actual reply");
  });

  it("suppresses when [THINKING]...[/THINKING] has no content after", () => {
    const { result, onSkip } = normalize("[THINKING] reasoning [/THINKING]");
    expect(result).toBeNull();
    expect(onSkip).toHaveBeenCalledWith("think");
  });

  it("handles case insensitivity — [thinking]", () => {
    const { result, onSkip } = normalize("[thinking] some reasoning");
    expect(result).toBeNull();
    expect(onSkip).toHaveBeenCalledWith("think");
  });

  it("handles case insensitivity for [thinking]...[/thinking] closing tag", () => {
    const { result } = normalize("[thinking] reasoning [/thinking] reply text");
    expect(result).not.toBeNull();
    expect(result!.text).toBe("reply text");
  });

  it("handles leading whitespace before [THINKING]", () => {
    const { result, onSkip } = normalize("   [THINKING] reasoning about things");
    expect(result).toBeNull();
    expect(onSkip).toHaveBeenCalledWith("think");
  });
});
