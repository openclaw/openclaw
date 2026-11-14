import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { formatCwdRelativePathOrAbsolute } from "./safe-cwd.js";

afterEach(() => vi.restoreAllMocks());

const cwd = path.resolve("/work/project");
it.each([
  [path.join(cwd, "plugins", "demo"), path.join("plugins", "demo")],
  [cwd, "."],
  [path.resolve("/work/elsewhere/demo"), path.resolve("/work/elsewhere/demo")],
  [path.resolve("/work"), path.resolve("/work")],
])("formats %s relative to the launch directory only when it is inside it", (target, expected) => {
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  expect(formatCwdRelativePathOrAbsolute(target, ".")).toBe(expected);
});

it("keeps the absolute path when the launch directory is gone", () => {
  vi.spyOn(process, "cwd").mockImplementation(() => {
    throw new Error("ENOENT: no such file or directory, uv_cwd");
  });
  expect(formatCwdRelativePathOrAbsolute(path.join(cwd, "demo"), ".")).toBe(path.join(cwd, "demo"));
});
