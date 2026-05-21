import { describe, expect, it, vi } from "vitest";
import { emitDoctorNotes } from "./emit-notes.js";

describe("doctor note emission", () => {
  it("emits grouped change and warning notes with the correct titles", () => {
    const note = vi.fn();

    emitDoctorNotes({
      note,
      changeNotes: ["change one", "change two"],
      warningNotes: ["warning one"],
    });

    expect(note.mock.calls).toEqual([
      ["change one", "Doctor changes"],
      ["change two", "Doctor changes"],
      ["warning one", "Doctor warnings"],
    ]);
  });

  it("emits only warning notes when changeNotes is omitted", () => {
    const note = vi.fn();

    emitDoctorNotes({
      note,
      warningNotes: ["warning only"],
    });

    expect(note.mock.calls).toEqual([["warning only", "Doctor warnings"]]);
  });

  it("sanitizes emitted notes from plugin-provided doctor output", () => {
    const note = vi.fn();

    emitDoctorNotes({
      note,
      changeNotes: ["change \u001B[31mred\u001B[0m\nnext line"],
      warningNotes: [
        `warning \u001B]8;;https://example.test\u001B\\link\u001B]8;;\u001B\\${String.fromCharCode(
          0x9b,
        )}\r`,
      ],
    });

    expect(note.mock.calls).toEqual([
      ["change red\nnext line", "Doctor changes"],
      ["warning link", "Doctor warnings"],
    ]);
  });

  it("emits info notes with the Doctor info title", () => {
    const note = vi.fn();

    emitDoctorNotes({
      note,
      infoNotes: ["info one", "info two"],
    });

    expect(note.mock.calls).toEqual([
      ["info one", "Doctor info"],
      ["info two", "Doctor info"],
    ]);
  });

  it("emits change, warning, and info notes in order", () => {
    const note = vi.fn();

    emitDoctorNotes({
      note,
      changeNotes: ["change one"],
      warningNotes: ["warning one"],
      infoNotes: ["info one"],
    });

    expect(note.mock.calls).toEqual([
      ["change one", "Doctor changes"],
      ["warning one", "Doctor warnings"],
      ["info one", "Doctor info"],
    ]);
  });

  it("emits nothing when note groups are omitted or empty", () => {
    const note = vi.fn();

    emitDoctorNotes({ note });
    emitDoctorNotes({ note, changeNotes: [], warningNotes: [], infoNotes: [] });

    expect(note).not.toHaveBeenCalled();
  });
});
