import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { resolveNodeRuntimeExecutableAsync } from "./node-runtime-executable.js";

const node = resolveTestNodeExecPath();
afterEach(() => vi.restoreAllMocks());

it("discovers a terminal's Node runtime without main-thread filesystem calls", async () => {
  vi.spyOn(process, "versions", "get").mockReturnValue({ ...process.versions, bun: "fixture" });
  const filesystem = [
    vi.spyOn(fs, "mkdtempSync"),
    vi.spyOn(fs, "writeFileSync"),
    vi.spyOn(fs, "rmSync"),
  ];
  expect(await resolveNodeRuntimeExecutableAsync({ env: { PATH: path.dirname(node) } })).toBe(node);
  for (const operation of filesystem) {
    expect(operation).not.toHaveBeenCalled();
  }
});
