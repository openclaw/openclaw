import { expect, it } from "vitest";
import { buildNodeShellCommand } from "./node-shell.js";

it.each([
  ["win32", ["cmd.exe", "/d", "/s", "/c"]],
  ["windows", ["cmd.exe", "/d", "/s", "/c"]],
  [" Windows 11 ", ["cmd.exe", "/d", "/s", "/c"]],
  ["darwin", ["/bin/sh", "-c"]],
  ["macOS", ["/bin/sh", "-c"]],
  ["macOS 26.5.2", ["/bin/sh", "-c"]],
  ["linux", ["/bin/sh", "-lc"]],
  [undefined, ["/bin/sh", "-lc"]],
  [null, ["/bin/sh", "-lc"]],
  ["   ", ["/bin/sh", "-lc"]],
] as const)("builds the node shell for platform %j", (platform, shell) => {
  expect(buildNodeShellCommand("echo hi", platform)).toEqual([...shell, "echo hi"]);
});
