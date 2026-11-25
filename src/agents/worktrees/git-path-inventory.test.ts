import { describe, expect, it } from "vitest";
import { splitNullBuffer } from "./git-path-inventory.js";

describe("NUL-delimited Git path bytes", () => {
  it.each([
    { input: [], expected: [] },
    { input: [0, 0], expected: [] },
    { input: [65], expected: [[65]] },
    { input: [0, 65, 0, 0, 255, 128, 0], expected: [[65], [255, 128]] },
    { input: [65, 0, 66, 255], expected: [[65], [66, 255]] },
  ])("keeps nonempty raw fields in $input", ({ input, expected }) => {
    expect(splitNullBuffer(Uint8Array.from(input)).map((field) => Array.from(field))).toEqual(
      expected,
    );
  });

  it("respects the input view and keeps zero-copy field slices", () => {
    const backing = Uint8Array.from([99, 65, 0, 0, 66, 128, 0, 99]);
    const input = backing.subarray(1, 7);
    const fields = splitNullBuffer(input);
    expect(fields.map((field) => Array.from(field))).toEqual([[65], [66, 128]]);
    for (const field of fields) {
      expect(field.buffer).toBe(backing.buffer);
    }
    backing[4] = 67;
    expect([...fields[1]!]).toEqual([67, 128]);
  });
});
