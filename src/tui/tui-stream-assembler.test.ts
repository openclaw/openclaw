import { beforeEach, describe, expect, it } from "vitest";
import { TuiStreamAssembler } from "./tui-stream-assembler.js";

const text = (value: string) => ({ type: "text", text: value }) as const;
const thinking = (value: string) => ({ type: "thinking", thinking: value }) as const;
const pairingQr = (terminalText: string) =>
  ({ type: "openclaw_pairing_qr", terminalText }) as const;

const message = (...content: readonly Record<string, unknown>[]) =>
  ({ role: "assistant", content }) as const;

describe("TuiStreamAssembler", () => {
  let assembler: TuiStreamAssembler;
  beforeEach(() => {
    assembler = new TuiStreamAssembler();
  });

  it("keeps thinking before content even when thinking arrives later", () => {
    expect(assembler.ingestDelta("run-1", message(text("Hello")), true)).toBe("Hello");
    expect(assembler.ingestDelta("run-1", message(thinking("Brain")), true)).toBe(
      "[thinking]\nBrain\n\nHello",
    );
  });

  it("tracks literal placeholder text as real displayable content until finalization", () => {
    expect(assembler.hasDisplayText("run-1")).toBe(false);
    assembler.ingestDelta("run-1", message(text("(no output)")), false);
    expect(assembler.hasDisplayText("run-1")).toBe(true);
    expect(assembler.finalize("run-1", message(), false)).toBe("(no output)");
    expect(assembler.hasDisplayText("run-1")).toBe(false);
  });

  it("renders pairing QR terminal text from final assistant content", () => {
    const prompt = "Scan this QR code with the OpenClaw iOS app:";
    const content = message(text(prompt), pairingQr("\u001b[47m\u001b[30m█ ▄\u001b[0m"));
    const finalText = assembler.finalize("run-pair-qr", content, false);
    expect(finalText).toContain(prompt);
    expect(finalText).toContain("█ ▄");
    expect(finalText).not.toContain("\u001b[47m");
    expect(finalText).not.toBe("(no output)");
  });

  it("keeps visible thinking ahead of an attachment-only final", () => {
    const finalText = assembler.finalize(
      "run-media-thinking",
      message(thinking("Preparing the attachment"), { type: "image", data: "secret-image" }),
      true,
    );
    expect(finalText).toBe("[thinking]\nPreparing the attachment\n\nAttached image");
  });

  it("keeps an error ahead of an attachment summary", () => {
    const finalText = assembler.finalize(
      "run-media-error",
      message({ type: "video", url: "file:///private/clip.mp4" }),
      false,
      "media generation failed",
    );
    expect(finalText).toContain("media generation failed");
    expect(finalText).not.toContain("Attached video");
  });

  it("returns null when delta text is unchanged", () => {
    expect(assembler.ingestDelta("run-4", message(text("Repeat")), false)).toBe("Repeat");
    expect(assembler.ingestDelta("run-4", message(text("Repeat")), false)).toBeNull();
  });

  it("bounds orphaned stream state while preserving recently active runs", () => {
    for (let index = 0; index < 200; index += 1) {
      assembler.ingestDelta(`run-${index}`, message(text(`Draft ${index}`)), false);
    }

    assembler.ingestDelta("run-0", message(text("Recently active")), false);
    assembler.ingestDelta("run-200", message(text("Newest")), false);
    expect(assembler.finalize("run-0", message(), false)).toBe("Recently active");
    expect(assembler.finalize("run-1", message(), false)).toBe("(no output)");
    expect(assembler.finalize("run-200", message(), false)).toBe("Newest");
  });

  it("does not evict an active run when an evicted run finalizes late", () => {
    for (let index = 0; index < 201; index += 1) {
      assembler.ingestDelta(`run-${index}`, message(text(`Draft ${index}`)), false);
    }

    expect(assembler.finalize("run-0", message(text("Late final")), false)).toBe("Late final");
    expect(assembler.finalize("run-1", message(), false)).toBe("Draft 1");
  });
});
