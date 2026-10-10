// Verifies streamed TUI message assembly and display state updates.
import { describe, expect, it } from "vitest";
import { TuiStreamAssembler } from "./tui-stream-assembler.js";

const text = (value: string) => ({ type: "text", text: value }) as const;
const thinking = (value: string) => ({ type: "thinking", thinking: value }) as const;
const toolUse = () => ({ type: "tool_use", name: "search" }) as const;
const pairingQr = (terminalText: string) =>
  ({ type: "openclaw_pairing_qr", terminalText }) as const;

const messageWithContent = (content: readonly Record<string, unknown>[]) =>
  ({
    role: "assistant",
    content,
  }) as const;

describe("TuiStreamAssembler", () => {
  it("keeps thinking before content even when thinking arrives later", () => {
    const assembler = new TuiStreamAssembler();
    const first = assembler.ingestDelta("run-1", messageWithContent([text("Hello")]), true);
    expect(first).toBe("Hello");

    const second = assembler.ingestDelta("run-1", messageWithContent([thinking("Brain")]), true);
    expect(second).toBe("[thinking]\nBrain\n\nHello");
  });

  it("defers streamed terminal sanitization to the markdown boundary", () => {
    const assembler = new TuiStreamAssembler();
    const unsafe = "before\x1b]52;c;unsafe\x07after";

    expect(assembler.ingestDelta("run-unsafe", messageWithContent([text(unsafe)]), false)).toBe(
      unsafe,
    );
  });

  it("retains hidden thinking across display toggles", () => {
    const assembler = new TuiStreamAssembler();
    const output = assembler.ingestDelta(
      "run-2",
      messageWithContent([thinking("Hidden"), text("Visible")]),
      false,
    );
    expect(output).toBe("Visible");
    expect(assembler.ingestDelta("run-2", messageWithContent([]), true)).toBe(
      "[thinking]\nHidden\n\nVisible",
    );
    expect(assembler.ingestDelta("run-2", messageWithContent([]), false)).toBe("Visible");
  });

  it("tracks literal placeholder text as real displayable content until finalization", () => {
    const assembler = new TuiStreamAssembler();

    expect(assembler.hasDisplayText("run-literal-output")).toBe(false);

    assembler.ingestDelta("run-literal-output", messageWithContent([text("(no output)")]), false);

    expect(assembler.hasDisplayText("run-literal-output")).toBe(true);
    expect(
      assembler.finalize("run-literal-output", { role: "assistant", content: [] }, false),
    ).toBe("(no output)");
    expect(assembler.hasDisplayText("run-literal-output")).toBe(false);
  });

  it("renders pairing QR terminal text from final assistant content", () => {
    const assembler = new TuiStreamAssembler();
    const finalText = assembler.finalize(
      "run-pair-qr",
      messageWithContent([
        text("Scan this QR code with the OpenClaw iOS app:"),
        pairingQr("\u001b[47m\u001b[30m█ ▄\u001b[0m"),
      ]),
      false,
    );
    expect(finalText).toContain("Scan this QR code with the OpenClaw iOS app:");
    expect(finalText).toContain("█ ▄");
    expect(finalText).not.toContain("\u001b[47m");
    expect(finalText).not.toBe("(no output)");
  });

  it("keeps visible thinking ahead of an attachment-only final", () => {
    const assembler = new TuiStreamAssembler();
    const finalText = assembler.finalize(
      "run-media-thinking",
      messageWithContent([
        thinking("Preparing the attachment"),
        { type: "image", data: "secret-image" },
      ]),
      true,
    );
    expect(finalText).toBe("[thinking]\nPreparing the attachment\n\nAttached image");
  });

  it("keeps a streamed caption ahead of an attachment-only final", () => {
    const assembler = new TuiStreamAssembler();
    assembler.ingestDelta(
      "run-media-caption",
      messageWithContent([text("Generated chart")]),
      false,
    );
    const finalText = assembler.finalize(
      "run-media-caption",
      messageWithContent([{ type: "image", data: "secret-image" }]),
      false,
    );
    expect(finalText).toBe("Generated chart");
  });

  it("keeps an error ahead of an attachment summary", () => {
    const assembler = new TuiStreamAssembler();
    const finalText = assembler.finalize(
      "run-media-error",
      messageWithContent([{ type: "video", url: "file:///private/clip.mp4" }]),
      false,
      "media generation failed",
    );
    expect(finalText).toContain("media generation failed");
    expect(finalText).not.toContain("Attached video");
  });

  it("returns null when delta text is unchanged", () => {
    const assembler = new TuiStreamAssembler();
    const first = assembler.ingestDelta("run-4", messageWithContent([text("Repeat")]), false);
    expect(first).toBe("Repeat");
    const second = assembler.ingestDelta("run-4", messageWithContent([text("Repeat")]), false);
    expect(second).toBeNull();
  });

  it("bounds orphaned stream state while preserving recently active runs", () => {
    const assembler = new TuiStreamAssembler();
    for (let index = 0; index < 200; index += 1) {
      assembler.ingestDelta(`run-${index}`, messageWithContent([text(`Draft ${index}`)]), false);
    }

    assembler.ingestDelta("run-0", messageWithContent([text("Recently active")]), false);
    assembler.ingestDelta("run-200", messageWithContent([text("Newest")]), false);

    expect(assembler.finalize("run-0", { role: "assistant", content: [] }, false)).toBe(
      "Recently active",
    );
    expect(assembler.finalize("run-1", { role: "assistant", content: [] }, false)).toBe(
      "(no output)",
    );
    expect(assembler.finalize("run-200", { role: "assistant", content: [] }, false)).toBe("Newest");
  });

  it("does not evict an active run when an evicted run finalizes late", () => {
    const assembler = new TuiStreamAssembler();
    for (let index = 0; index < 201; index += 1) {
      assembler.ingestDelta(`run-${index}`, messageWithContent([text(`Draft ${index}`)]), false);
    }

    expect(assembler.finalize("run-0", messageWithContent([text("Late final")]), false)).toBe(
      "Late final",
    );
    expect(assembler.finalize("run-1", { role: "assistant", content: [] }, false)).toBe("Draft 1");
  });

  it("prefers final text when non-text appears only in final payload", () => {
    const assembler = new TuiStreamAssembler();
    assembler.ingestDelta(
      "run-boundary",
      messageWithContent([text("Draft line 1"), text("Draft line 2")]),
      false,
    );
    expect(
      assembler.finalize(
        "run-boundary",
        messageWithContent([toolUse(), text("Draft line 2")]),
        false,
      ),
    ).toBe("Draft line 2");
  });
});
