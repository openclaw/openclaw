import { describe, expect, it } from "vitest";
import { parseHeaderArgs } from "./header-args.js";

describe("parseHeaderArgs", () => {
  it("returns empty object when given undefined or empty array", () => {
    expect(parseHeaderArgs(undefined)).toEqual({});
    expect(parseHeaderArgs([])).toEqual({});
  });

  it("parses single Name: value header", () => {
    expect(parseHeaderArgs(["X-Custom: value"])).toEqual({ "X-Custom": "value" });
  });

  it("parses multiple headers", () => {
    expect(
      parseHeaderArgs(["CF-Access-Client-Id: id123", "CF-Access-Client-Secret: secret"]),
    ).toEqual({
      "CF-Access-Client-Id": "id123",
      "CF-Access-Client-Secret": "secret",
    });
  });

  it("trims key and value", () => {
    expect(parseHeaderArgs(["  Key  :  val  "])).toEqual({ Key: "val" });
  });

  it("allows value to contain colons", () => {
    expect(parseHeaderArgs(["Name: value: with: colons"])).toEqual({
      Name: "value: with: colons",
    });
  });

  it("throws when entry has no colon", () => {
    expect(() => parseHeaderArgs(["no-colon"])).toThrow(/Invalid --header: must be "Name: value"/);
  });

  it("throws when header name is empty", () => {
    expect(() => parseHeaderArgs([": value"])).toThrow(
      /Invalid --header: header name must be non-empty/,
    );
  });
});
