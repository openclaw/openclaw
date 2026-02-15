import { describe, expect, it } from "vitest";
import { readFields } from "./shared.js";

describe("readFields", () => {
  it("parses fields with ref, type, and value", async () => {
    const result = await readFields({
      fields: JSON.stringify([{ ref: "1", type: "textbox", value: "hello" }]),
    });
    expect(result).toEqual([{ ref: "1", type: "textbox", value: "hello" }]);
  });

  it("defaults type to textbox when omitted", async () => {
    const result = await readFields({
      fields: JSON.stringify([{ ref: "1", value: "hello" }]),
    });
    expect(result).toEqual([{ ref: "1", type: "textbox", value: "hello" }]);
  });

  it("defaults type to textbox for multiple fields", async () => {
    const result = await readFields({
      fields: JSON.stringify([
        { ref: "1", value: "first" },
        { ref: "2", value: "second" },
      ]),
    });
    expect(result).toEqual([
      { ref: "1", type: "textbox", value: "first" },
      { ref: "2", type: "textbox", value: "second" },
    ]);
  });

  it("preserves explicit type when provided", async () => {
    const result = await readFields({
      fields: JSON.stringify([
        { ref: "1", type: "checkbox", value: true },
        { ref: "2", type: "radio", value: false },
      ]),
    });
    expect(result).toEqual([
      { ref: "1", type: "checkbox", value: true },
      { ref: "2", type: "radio", value: false },
    ]);
  });

  it("handles mixed fields: some with type, some without", async () => {
    const result = await readFields({
      fields: JSON.stringify([
        { ref: "1", type: "checkbox", value: true },
        { ref: "2", value: "text" },
      ]),
    });
    expect(result).toEqual([
      { ref: "1", type: "checkbox", value: true },
      { ref: "2", type: "textbox", value: "text" },
    ]);
  });

  it("accepts numeric value", async () => {
    const result = await readFields({
      fields: JSON.stringify([{ ref: "1", value: 42 }]),
    });
    expect(result).toEqual([{ ref: "1", type: "textbox", value: 42 }]);
  });

  it("accepts boolean value", async () => {
    const result = await readFields({
      fields: JSON.stringify([{ ref: "1", value: false }]),
    });
    expect(result).toEqual([{ ref: "1", type: "textbox", value: false }]);
  });

  it("omits value when null", async () => {
    const result = await readFields({
      fields: JSON.stringify([{ ref: "1", value: null }]),
    });
    expect(result).toEqual([{ ref: "1", type: "textbox" }]);
  });

  it("omits value when undefined (missing)", async () => {
    const result = await readFields({
      fields: JSON.stringify([{ ref: "1" }]),
    });
    expect(result).toEqual([{ ref: "1", type: "textbox" }]);
  });

  it("throws when fields string is empty", async () => {
    await expect(readFields({ fields: "" })).rejects.toThrow("fields are required");
  });

  it("throws when fields string is whitespace", async () => {
    await expect(readFields({ fields: "   " })).rejects.toThrow("fields are required");
  });

  it("throws when neither fields nor fieldsFile is provided", async () => {
    await expect(readFields({})).rejects.toThrow("fields are required");
  });

  it("throws when fields is not an array", async () => {
    await expect(readFields({ fields: '{"ref":"1"}' })).rejects.toThrow("fields must be an array");
  });

  it("throws when field entry is not an object", async () => {
    await expect(readFields({ fields: '["not-an-object"]' })).rejects.toThrow(
      "fields[0] must be an object",
    );
  });

  it("throws when field entry is null", async () => {
    await expect(readFields({ fields: "[null]" })).rejects.toThrow("fields[0] must be an object");
  });

  it("throws when ref is missing", async () => {
    await expect(readFields({ fields: JSON.stringify([{ value: "hello" }]) })).rejects.toThrow(
      "fields[0] must include ref",
    );
  });

  it("throws when ref is empty string", async () => {
    await expect(
      readFields({ fields: JSON.stringify([{ ref: "", value: "hello" }]) }),
    ).rejects.toThrow("fields[0] must include ref");
  });

  it("throws for invalid value type (object)", async () => {
    await expect(
      readFields({ fields: JSON.stringify([{ ref: "1", value: { nested: true } }]) }),
    ).rejects.toThrow("fields[0].value must be string, number, boolean, or null");
  });

  it("throws for invalid value type (array)", async () => {
    await expect(
      readFields({ fields: JSON.stringify([{ ref: "1", value: [1, 2] }]) }),
    ).rejects.toThrow("fields[0].value must be string, number, boolean, or null");
  });

  it("reports correct index in error for second field", async () => {
    await expect(
      readFields({
        fields: JSON.stringify([{ ref: "1", value: "ok" }, { value: "no-ref" }]),
      }),
    ).rejects.toThrow("fields[1] must include ref");
  });

  it("trims whitespace from ref", async () => {
    const result = await readFields({
      fields: JSON.stringify([{ ref: "  5  ", value: "test" }]),
    });
    expect(result[0].ref).toBe("5");
  });

  it("trims whitespace from type", async () => {
    const result = await readFields({
      fields: JSON.stringify([{ ref: "1", type: "  checkbox  ", value: true }]),
    });
    expect(result[0].type).toBe("checkbox");
  });
});
