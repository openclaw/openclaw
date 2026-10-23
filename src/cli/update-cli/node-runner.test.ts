import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveNodeRunner } from "./node-runner.js";

afterEach(() => vi.unstubAllGlobals());

it.each([
  [undefined, "node", true],
  [undefined, "NODE.EXE", true],
  [undefined, "bun", false],
  [undefined, "command-shim", false],
  ["1.4.3", "bun", true],
  ["1.4.3", "app-runtime", true],
] as const)("selects CLI children for Bun=%s and executable=%s", (bun, name, current) => {
  const execPath = path.resolve("fixture-runtime", name);
  vi.stubGlobal("process", { ...process, execPath, versions: { ...process.versions, bun } });
  expect(resolveNodeRunner()).toBe(current ? execPath : "node");
});

it("retains the running Node or Bun executable", () => {
  expect(resolveNodeRunner()).toBe(process.execPath);
});
