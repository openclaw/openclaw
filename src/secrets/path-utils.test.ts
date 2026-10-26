import { describe, expect, it } from "vitest";
import {
  deletePathStrict,
  getPath,
  setPathCreateStrict,
  setPathExistingStrict,
} from "./path-utils.js";

const BLOCKED_PATH_SEGMENTS = ["__proto__", "constructor", "prototype"];
const POLLUTION_PROBE = "openclawPathPollutionProbe";
const createArrayConfig = () => ({ accounts: [{ id: "a" }] });

describe("secrets path utils", () => {
  it.each([
    [{ value: "root" }, [], undefined],
    [{ value: null }, ["value", "child"], undefined],
    [{ values: [{ "0": "literal" }] }, ["values", "0", "0"], "literal"],
    [{ values: [] }, ["values", "0"], undefined],
  ] as const)("reads %j at %j without changing path semantics", (root, segments, expected) => {
    expect(getPath(root, [...segments])).toBe(expected);
  });

  it("deletePathStrict compacts arrays via splice", () => {
    const config = {};
    setPathCreateStrict(config, ["accounts"], [{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(deletePathStrict(config, ["accounts", "1"])).toBe(true);
    expect(getPath(config, ["accounts"])).toEqual([{ id: "a" }, { id: "c" }]);
  });

  it("getPath returns undefined for invalid array path segment", () => {
    const config = createArrayConfig();
    for (const segment of ["foo", "0abc", "+0", "9007199254740993", "4294967294"]) {
      expect(getPath(config, ["accounts", segment])).toBeUndefined();
    }
  });

  it("setPathCreateStrict rejects unsafe array path segments", () => {
    const config = createArrayConfig();

    for (const index of [Number.MAX_SAFE_INTEGER + 2, 4294967294]) {
      expect(() => setPathCreateStrict(config, ["accounts", index, "id"], "b")).toThrow(
        /Invalid array index segment/,
      );
    }
    expect(() => setPathCreateStrict(config, ["accounts", "+0", "id"], "b")).toThrow(
      /Invalid path shape/,
    );
  });

  it.each([{}, { safe: { value: "kept" } }])("rejects unsafe paths without mutating %j", (root) => {
    for (const blockedSegment of BLOCKED_PATH_SEGMENTS) {
      const segments = ["safe", blockedSegment, POLLUTION_PROBE];
      for (const mutate of [setPathCreateStrict, setPathExistingStrict, deletePathStrict]) {
        const config = structuredClone(root);
        expect(() => mutate(config, segments, "changed")).toThrow(/prototype-polluting/);
        expect(config).toEqual(root);
        expect(Object.hasOwn(Object.prototype, POLLUTION_PROBE)).toBe(false);
      }
    }
  });

  it("setPathExistingStrict throws when path does not already exist", () => {
    const config = createArrayConfig();
    expect(() =>
      setPathExistingStrict(config, ["accounts", "0", "credentials", "remote", "apiKey"], "x"),
    ).toThrow(/Path segment does not exist/);
  });

  it.each([
    ["updates an existing leaf", setPathExistingStrict, "old", "new", true],
    ["creates missing containers", setPathCreateStrict, undefined, "x", true],
    ["leaves equal values unchanged", setPathCreateStrict, "same", "same", false],
  ] as const)("%s", (_name, write, before, value, changed) => {
    const config = before === undefined ? {} : { talk: { apiKey: before } };
    const segments = before === undefined ? ["talk", "provider", "apiKey"] : ["talk", "apiKey"];
    expect(write(config, segments, value)).toBe(changed);
    expect(getPath(config, segments)).toBe(value);
  });

  it.each([
    [0, { accounts: [{ token: "secret" }] }, { accounts: { "0": { token: "old" } } }],
    ["0", { accounts: { "0": { token: "secret" } } }, { accounts: [{ token: "old" }] }],
  ] as const)(
    "preserves the container contract for segment %j",
    (segment, expected, mismatched) => {
      const config = {};
      expect(setPathCreateStrict(config, ["accounts", segment, "token"], "secret")).toBe(true);
      expect(config).toEqual(expected);
      expect(() =>
        setPathCreateStrict(mismatched, ["accounts", segment, "token"], "secret"),
      ).toThrow(/Invalid path shape/);
      expect(mismatched.accounts[0].token).toBe("old");
    },
  );
});
