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
});
