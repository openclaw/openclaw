/** Tests dotted-path get/set/delete helpers used by secrets migration. */
import { describe, expect, it } from "vitest";
import {
  deletePathStrict,
  getPath,
  setPathCreateStrict,
  setPathExistingStrict,
} from "./path-utils.js";

function createArrayConfig(): Record<string, unknown> {
  return { accounts: [{ id: "a" }] };
}

const BLOCKED_PATH_SEGMENTS = ["__proto__", "constructor", "prototype"];
const POLLUTION_PROBE = "openclawPathPollutionProbe";

describe("secrets path utils", () => {
  it("deletePathStrict compacts arrays via splice", () => {
    const config = {};
    setPathCreateStrict(config, ["accounts"], [{ id: "a" }, { id: "b" }, { id: "c" }]);
    const changed = deletePathStrict(config, ["accounts", "1"]);
    expect(changed).toBe(true);
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

  it("setPathCreateStrict rejects __proto__ before creating partial containers", () => {
    const config = {};
    expect(() =>
      setPathCreateStrict(config, ["safe", "__proto__", POLLUTION_PROBE], "yes"),
    ).toThrow(/prototype-polluting/);
    expect(config).toEqual({});
    expect(Object.hasOwn(Object.prototype, POLLUTION_PROBE)).toBe(false);
  });

  it("all mutation helpers reject blocked segments in the middle", () => {
    for (const blockedSegment of BLOCKED_PATH_SEGMENTS) {
      const segments = ["safe", blockedSegment, POLLUTION_PROBE];
      const config = { safe: { value: "kept" } };
      for (const mutate of [setPathCreateStrict, setPathExistingStrict, deletePathStrict]) {
        expect(() => mutate(config, segments, "changed")).toThrow(/prototype-polluting/);
      }
      expect(config).toEqual({ safe: { value: "kept" } });
    }
  });

  it("setPathExistingStrict throws when path does not already exist", () => {
    const config = createArrayConfig();
    expect(() =>
      setPathExistingStrict(config, ["accounts", "0", "credentials", "remote", "apiKey"], "x"),
    ).toThrow(/Path segment does not exist/);
  });

  it("setPathExistingStrict updates an existing leaf", () => {
    const config = { talk: { apiKey: "old" } }; // pragma: allowlist secret
    const changed = setPathExistingStrict(config, ["talk", "apiKey"], "new");
    expect(changed).toBe(true);
    expect(getPath(config, ["talk", "apiKey"])).toBe("new");
  });

  it("setPathCreateStrict creates missing container segments", () => {
    const config = {};
    const changed = setPathCreateStrict(config, ["talk", "provider", "apiKey"], "x");
    expect(changed).toBe(true);
    expect(getPath(config, ["talk", "provider", "apiKey"])).toBe("x");
  });

  it.each([
    {
      name: "array index",
      segment: 0,
      expected: { accounts: [{ token: "secret" }] },
      mismatched: { accounts: { "0": { token: "old" } } },
    },
    {
      name: "numeric record key",
      segment: "0",
      expected: { accounts: { "0": { token: "secret" } } },
      mismatched: { accounts: [{ token: "old" }] },
    },
  ])(
    "setPathCreateStrict preserves the $name container contract",
    ({ segment, expected, mismatched }) => {
      const config = {};

      expect(setPathCreateStrict(config, ["accounts", segment, "token"], "secret")).toBe(true);
      expect(config).toEqual(expected);
      expect(() =>
        setPathCreateStrict(mismatched, ["accounts", segment, "token"], "secret"),
      ).toThrow(/Invalid path shape/);
      expect(mismatched.accounts[0].token).toBe("old");
    },
  );

  it("setPathCreateStrict leaves value unchanged when equal", () => {
    const config = { talk: { apiKey: "same" } }; // pragma: allowlist secret
    const changed = setPathCreateStrict(config, ["talk", "apiKey"], "same");
    expect(changed).toBe(false);
    expect(getPath(config, ["talk", "apiKey"])).toBe("same");
  });
});
