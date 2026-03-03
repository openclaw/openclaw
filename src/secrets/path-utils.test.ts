import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  deletePathStrict,
  getPath,
  setPathCreateStrict,
  setPathExistingStrict,
} from "./path-utils.js";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

describe("secrets path utils", () => {
  it("deletePathStrict compacts arrays via splice", () => {
    const config = asConfig({});
    setPathCreateStrict(config, ["agents", "list"], [{ id: "a" }, { id: "b" }, { id: "c" }]);
    const changed = deletePathStrict(config, ["agents", "list", "1"]);
    expect(changed).toBe(true);
    expect(getPath(config, ["agents", "list"])).toEqual([{ id: "a" }, { id: "c" }]);
  });

  it("getPath returns undefined for invalid array path segment", () => {
    const config = asConfig({
      agents: {
        list: [{ id: "a" }],
      },
    });
    expect(getPath(config, ["agents", "list", "foo"])).toBeUndefined();
  });

  it("setPathExistingStrict throws when path does not already exist", () => {
    const config = asConfig({
      agents: {
        list: [{ id: "a" }],
      },
    });
    expect(() =>
      setPathExistingStrict(
        config,
        ["agents", "list", "0", "memorySearch", "remote", "apiKey"],
        "x",
      ),
    ).toThrow(/Path segment does not exist/);
  });

  it("setPathExistingStrict updates an existing leaf", () => {
    const config = asConfig({
      talk: {
        apiKey: "old",
      },
    });
    const changed = setPathExistingStrict(config, ["talk", "apiKey"], "new");
    expect(changed).toBe(true);
    expect(getPath(config, ["talk", "apiKey"])).toBe("new");
  });

  it("setPathCreateStrict creates missing container segments", () => {
    const config = asConfig({});
    const changed = setPathCreateStrict(config, ["talk", "provider", "apiKey"], "x");
    expect(changed).toBe(true);
    expect(getPath(config, ["talk", "provider", "apiKey"])).toBe("x");
  });

  it("setPathCreateStrict leaves value unchanged when equal", () => {
    const config = asConfig({
      talk: {
        apiKey: "same",
      },
    });
    const changed = setPathCreateStrict(config, ["talk", "apiKey"], "same");
    expect(changed).toBe(false);
    expect(getPath(config, ["talk", "apiKey"])).toBe("same");
  });

  it("setPathExistingStrict fails when intermediate segment is missing", () => {
    const config = asConfig({
      agents: {
        list: [{ id: "a" }],
      },
    });
    expect(() =>
      setPathExistingStrict(
        config,
        ["agents", "list", "0", "memorySearch", "remote", "apiKey"],
        "x",
      ),
    ).toThrow(/Path segment does not exist/);
  });
});
