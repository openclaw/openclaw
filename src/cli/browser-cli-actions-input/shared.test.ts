import { describe, expect, it } from "vitest";
import { readFields } from "./shared.js";

describe("readFields", () => {
  it("defaults missing type to text", async () => {
    await expect(readFields({ fields: '[{"ref":"7","value":"world"}]' })).resolves.toEqual([
      { ref: "7", type: "text", value: "world" },
    ]);
  });

  it("requires ref", async () => {
    await expect(readFields({ fields: '[{"type":"textbox","value":"world"}]' })).rejects.toThrow(
      "fields[0] must include ref",
    );
  });
});
