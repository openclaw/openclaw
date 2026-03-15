import os from "node:os";
import { describe, expect, it } from "vitest";
import { normalizeToolParams } from "./pi-tools.params.js";

describe("normalizeToolParams tilde expansion", () => {
  it("expands ~ in path parameter", () => {
    const home = os.homedir();
    const params = { path: "~/.ssh/config" };
    const normalized = normalizeToolParams(params);
    expect(normalized?.path).toBe(`${home}/.ssh/config`);
  });

  it("expands ~ in file_path parameter (aliased to path)", () => {
    const home = os.homedir();
    const params = { file_path: "~/Documents/notes.txt" };
    const normalized = normalizeToolParams(params);
    expect(normalized?.path).toBe(`${home}/Documents/notes.txt`);
  });

  it("does not expand ~ if it is not at the start of the path", () => {
    const params = { path: "/some/path/~middle" };
    const normalized = normalizeToolParams(params);
    expect(normalized?.path).toBe("/some/path/~middle");
  });

  it("handles paths without tilde", () => {
    const params = { path: "/etc/hosts" };
    const normalized = normalizeToolParams(params);
    expect(normalized?.path).toBe("/etc/hosts");
  });
});
