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

it.each([
  "/usr/bin/node /tmp/script.cjs $HOME",
  "/usr/bin/node /tmp/script.cjs $(id)",
  "/usr/bin/node /tmp/script.cjs *.txt",
  '/usr/bin/node /tmp/script.cjs "two words"',
  "/usr/bin/node /tmp/script.cjs x; /usr/bin/id",
  "/usr/bin/node /tmp/script.cjs x | /bin/cat",
  "/usr/bin/node /tmp/script.cjs x > output.txt",
  "/usr/bin/node /tmp/script.cjs x # comment",
  "/usr/bin/node /tmp/script.cjs  x",
  "/usr/bin/node /tmp/script.cjs\tx",
  "/usr/bin/node /tmp/script.cjs x\n",
  "/usr/bin/node /tmp/script.cjs x\r\n",
])("preserves Mac shell semantics for %j", (command) => {
  expect(buildNodeShellCommand(command, "darwin")).toEqual(["/bin/sh", "-c", command]);
});

it.each(["linux", undefined, null])("keeps login-shell transport on %j", (platform) => {
  const command = "/usr/bin/printf literal";
  expect(buildNodeShellCommand(command, platform)).toEqual(["/bin/sh", "-lc", command]);
});

it("keeps Windows transport for literal absolute commands", () => {
  const command = "/usr/bin/printf literal";
  expect(buildNodeShellCommand(command, "Windows 11")).toEqual([
    "cmd.exe",
    "/d",
    "/s",
    "/c",
    command,
  ]);
});

it("keeps native commands on the persisted shell approval identity", () => {
  const command = "/usr/bin/printf node-policy-proof";
  expect(buildNodeShellCommand(command, "darwin")).toEqual(["/bin/sh", "-c", command]);
});
