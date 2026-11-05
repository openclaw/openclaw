import { describe, expect, it } from "vitest";
import {
  deletePathStrict as deletePath,
  getPath,
  setPathCreateStrict as createPath,
  setPathExistingStrict as updatePath,
} from "./path-utils.js";

const BLOCKED_PATH_SEGMENTS = ["__proto__", "constructor", "prototype"];
const POLLUTION_PROBE = "openclawPathPollutionProbe";
const createArrayConfig = () => ({ accounts: [{ id: "a" }] });

describe("secrets path utils", () => {
  it("does not treat an empty path as the root", () => {
    expect(getPath({ value: "root" }, [])).toBeUndefined();
  });

  it("deletePathStrict compacts arrays via splice", () => {
    const config = {};
    createPath(config, ["accounts"], [{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(deletePath(config, ["accounts", "1"])).toBe(true);
    expect(getPath(config, ["accounts"])).toEqual([{ id: "a" }, { id: "c" }]);
  });

  it("setPathCreateStrict rejects unsafe array path segments", () => {
    const config = createArrayConfig();

    for (const index of [Number.MAX_SAFE_INTEGER + 2, 4294967294]) {
      expect(() => createPath(config, ["accounts", index, "id"], "b")).toThrow(
        /Invalid array index segment/,
      );
    }
  });

  it.each([{}, { safe: { value: "kept" } }])("rejects unsafe paths without mutating %j", (root) => {
    for (const blockedSegment of BLOCKED_PATH_SEGMENTS) {
      const segments = ["safe", blockedSegment, POLLUTION_PROBE];
      for (const mutate of [createPath, updatePath, deletePath]) {
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
      updatePath(config, ["accounts", "0", "credentials", "remote", "apiKey"], "x"),
    ).toThrow(/Path segment does not exist/);
  });

  it.each([
    ["updates an existing leaf", updatePath, "old", "new", true],
    ["leaves equal values unchanged", createPath, "same", "same", false],
  ] as const)("%s", (_name, write, before, value, changed) => {
    const config = { talk: { apiKey: before } };
    const segments = ["talk", "apiKey"];
    expect(write(config, segments, value)).toBe(changed);
    expect(getPath(config, segments)).toBe(value);
  });

  it.each([
    [0, { accounts: [{ token: "secret" }] }, { accounts: { "0": { token: "old" } } }],
    ["0", { accounts: { "0": { token: "secret" } } }, { accounts: [{ token: "old" }] }],
  ] as const)("uses typed segments (%j)", (segment, expected, mismatched) => {
    const config = {};
    expect(createPath(config, ["accounts", segment, "token"], "secret")).toBe(true);
    expect(config).toEqual(expected);
    expect(() => createPath(mismatched, ["accounts", segment, "token"], "secret")).toThrow(
      /Invalid path shape/,
    );
    expect(mismatched.accounts[0].token).toBe("old");
  });
});
