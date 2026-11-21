import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { observeMainThreadFs } from "../test-utils/main-thread-fs-spies.test-support.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { resolveNodeRuntimeExecutableAsync } from "./node-runtime-executable.js";

const node = resolveTestNodeExecPath();
afterEach(() => vi.restoreAllMocks());

it("discovers a terminal's Node runtime without main-thread filesystem calls", async () => {
  vi.spyOn(process, "versions", "get").mockReturnValue({ ...process.versions, bun: "fixture" });
  using filesystem = observeMainThreadFs();
  expect(await resolveNodeRuntimeExecutableAsync({ env: { PATH: path.dirname(node) } })).toBe(node);
  expect(filesystem.calls()).toEqual({});
});
