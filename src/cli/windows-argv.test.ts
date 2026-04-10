import { afterEach, describe, expect, it } from "vitest";
import { normalizeWindowsArgv } from "./windows-argv.js";

const originalPlatform = process.platform;
const originalExecPath = process.execPath;

describe("normalizeWindowsArgv", () => {
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
  });

  it("keeps regular args that only contain node.exe text", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    Object.defineProperty(process, "execPath", {
      value: "C:\\Program Files\\nodejs\\node.exe",
      configurable: true,
    });

    const argv = ["node", "openclaw", "run", "--note", "copied-from-node.exe-docs", "task"];

    expect(normalizeWindowsArgv(argv)).toEqual(argv);
  });

  it("removes duplicated node executable args from wrappers", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    Object.defineProperty(process, "execPath", {
      value: "C:\\Program Files\\nodejs\\node.exe",
      configurable: true,
    });

    const argv = ["node", "C:\\Program Files\\nodejs\\node.exe", "openclaw", "status", "--json"];

    expect(normalizeWindowsArgv(argv)).toEqual(["node", "openclaw", "status", "--json"]);
  });
});
