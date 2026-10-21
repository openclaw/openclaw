import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildLaunchAgentPlist, readLaunchAgentProgramArgumentsFromFile } from "./launchd-plist.js";
import { decodeLaunchAgentPlistFixture } from "./launchd-plist.test-support.js";

vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runExec: vi.fn(
    async (_command: string, args: string[], options: { input: string | Uint8Array }) =>
      decodeLaunchAgentPlistFixture(options.input, args[1]),
  ),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const readCommand = readLaunchAgentProgramArgumentsFromFile;
const buildPlist = (overrides: Partial<Parameters<typeof buildLaunchAgentPlist>[0]> = {}) =>
  buildLaunchAgentPlist({
    label: "ai.openclaw.gateway",
    programArguments: ["openclaw", "gateway"],
    stdoutPath: "/dev/null",
    stderrPath: "/dev/null",
    ...overrides,
  });
const writePlist = (file: string, overrides: Parameters<typeof buildPlist>[0]) =>
  fs.writeFile(file, buildPlist(overrides));

async function environmentFixture(contents: string, environment?: Record<string, string>) {
  const dir = dirs.make("openclaw-plist-env-");
  const plistPath = path.join(dir, "gateway.plist");
  const envFile = path.join(dir, "gateway.env");
  const wrapper = path.join(dir, "gateway-env-wrapper.sh");
  await fs.writeFile(envFile, contents);
  await writePlist(plistPath, {
    programArguments: ["/bin/sh", wrapper, envFile, "openclaw", "gateway"],
    environment,
  });
  return { plistPath, envFile, wrapper };
}

it("gives the installed Gateway 330 seconds to drain and exit", () => {
  expect(buildPlist()).toMatch(/<key>ExitTimeOut<\/key>\s*<integer>330<\/integer>/u);
});

it.each([false, true])("round-trips environment (strict=%s)", async (strict) => {
  const contents = strict
    ? "export FILE='file'\nexport SHARED='file wins'\n"
    : "export EDITED=$(id)\nexport NEXT='retained'\n";
  const inline = strict ? { INLINE: "inline", SHARED: "original" } : undefined;
  const { plistPath, envFile, wrapper } = await environmentFixture(contents, inline);
  const options = {
    requireEffective: true,
    expectedEnvironmentWrapperPath: wrapper,
    expectedEnvironmentFilePath: envFile,
  };
  const command = await readCommand(plistPath, strict ? options : undefined);
  expect(command?.environment).toMatchObject(
    strict
      ? { INLINE: "inline", SHARED: "file wins", FILE: "file" }
      : { EDITED: "$(id)", NEXT: "retained" },
  );
  if (strict) {
    expect(command).toMatchObject({
      programArguments: ["openclaw", "gateway"],
      environmentValueSources: { INLINE: "inline", SHARED: "inline-and-file", FILE: "file" },
    });
  }
});

it.each(["", "--max-old-space-size=24576"])("preserves NODE_OPTIONS=%j", async (nodeOptions) => {
  const plistPath = path.join(dirs.make("openclaw-plist-env-"), "gateway.plist");
  const programArguments = ["/usr/bin/node", "--max-old-space-size=16384", "gateway.js"];
  await writePlist(plistPath, {
    programArguments,
    environment: { NODE_OPTIONS: nodeOptions, UNUSED: "", MISSING: undefined },
  });
  const command = await readCommand(plistPath);
  expect(command?.environment).toEqual({ NODE_OPTIONS: nodeOptions });
  expect(command?.programArguments).toEqual(programArguments);
});
