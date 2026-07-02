// Tests for parameter key normalization.
import { describe, expect, it } from "vitest";
import { resolveSnakeCaseParamKey, readSnakeCaseParamRaw } from "./param-key.js";

describe("resolveSnakeCaseParamKey", () => {
  it("returns exact key when it exists", () => {
    const params = { myKey: "value" };
    expect(resolveSnakeCaseParamKey(params, "myKey")).toBe("myKey");
  });

  it("returns snake_case key when camelCase key is not found", () => {
    const params = { my_key: "value" };
    expect(resolveSnakeCaseParamKey(params, "myKey")).toBe("my_key");
  });

  it("returns camelCase key when it exists (even if snake_case also exists)", () => {
    const params = { myKey: "camel", my_key: "snake" };
    expect(resolveSnakeCaseParamKey(params, "myKey")).toBe("myKey");
  });

  it("returns undefined when neither key exists", () => {
    const params = { other: "value" };
    expect(resolveSnakeCaseParamKey(params, "myKey")).toBeUndefined();
  });

  it("handles keys with multiple uppercase letters", () => {
    const params = { my_xml_parser: "value" };
    expect(resolveSnakeCaseParamKey(params, "myXMLParser")).toBe("my_xml_parser");
  });

  it("handles keys with numbers", () => {
    const params = { max_retries2: "value" };
    expect(resolveSnakeCaseParamKey(params, "maxRetries2")).toBe("max_retries2");
  });

  it("preserves whitespace in keys", () => {
    const params = { "my key": "value" };
    expect(resolveSnakeCaseParamKey(params, "my key")).toBe("my key");
  });

  it("returns undefined for empty params", () => {
    expect(resolveSnakeCaseParamKey({}, "myKey")).toBeUndefined();
  });
});

describe("readSnakeCaseParamRaw", () => {
  it("reads value with exact key", () => {
    const params = { myKey: "value" };
    expect(readSnakeCaseParamRaw(params, "myKey")).toBe("value");
  });

  it("reads value with snake_case key", () => {
    const params = { my_key: "value" };
    expect(readSnakeCaseParamRaw(params, "myKey")).toBe("value");
  });

  it("returns undefined when key not found", () => {
    const params = { other: "value" };
    expect(readSnakeCaseParamRaw(params, "myKey")).toBeUndefined();
  });

  it("returns null value when key exists", () => {
    const params = { myKey: null };
    expect(readSnakeCaseParamRaw(params, "myKey")).toBeNull();
  });

  it("returns undefined value when key exists", () => {
    const params = { myKey: undefined };
    expect(readSnakeCaseParamRaw(params, "myKey")).toBeUndefined();
  });

  it("reads object value", () => {
    const params = { myKey: { nested: true } };
    expect(readSnakeCaseParamRaw(params, "myKey")).toEqual({ nested: true });
  });

  it("reads array value", () => {
    const params = { myKey: [1, 2, 3] };
    expect(readSnakeCaseParamRaw(params, "myKey")).toEqual([1, 2, 3]);
  });
});
