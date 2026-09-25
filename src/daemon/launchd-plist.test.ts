// Launchd plist tests preserve the generated service command and environment.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("LaunchAgent environment round-trip", () => {
  it("preserves inline, file, and overlapping provenance after merging generated environment", async () => {
    const dir = dirs.make("openclaw-plist-provenance-");
    const plistPath = path.join(dir, "gateway.plist");
    const envFile = path.join(dir, "gateway.env");
    const wrapper = path.join(dir, "gateway-env-wrapper.sh");
    await fs.writeFile(envFile, "export FILE='file'\nexport SHARED='file wins'\n");
    await fs.writeFile(
      plistPath,
      buildLaunchAgentPlist({
        label: "ai.openclaw.gateway",
        programArguments: ["/bin/sh", wrapper, envFile, "openclaw", "gateway"],
        stdoutPath: "/dev/null",
        stderrPath: "/dev/null",
        environment: { INLINE: "inline", SHARED: "original" },
      }),
    );
    const command = await readLaunchAgentProgramArgumentsFromFile(plistPath, {
      requireEffective: true,
      expectedEnvironmentWrapperPath: wrapper,
      expectedEnvironmentFilePath: envFile,
    });
    expect(command).toMatchObject({
      programArguments: ["openclaw", "gateway"],
      environment: { INLINE: "inline", SHARED: "file wins", FILE: "file" },
      environmentValueSources: { INLINE: "inline", SHARED: "inline-and-file", FILE: "file" },
    });
  });

  it.each(["", "--max-old-space-size=24576"])(
    "preserves explicit NODE_OPTIONS=%j while omitting other empty values",
    async (nodeOptions) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plist-env-"));
      const plistPath = path.join(dir, "gateway.plist");
      const programArguments = ["/usr/bin/node", "--max-old-space-size=16384", "gateway.js"];
      try {
        await fs.writeFile(
          plistPath,
          buildLaunchAgentPlist({
            label: "ai.openclaw.gateway",
            programArguments,
            stdoutPath: path.join(dir, "stdout.log"),
            stderrPath: path.join(dir, "stderr.log"),
            environment: { NODE_OPTIONS: nodeOptions, UNUSED: "", MISSING: undefined },
          }),
        );
        const command = await readLaunchAgentProgramArgumentsFromFile(plistPath);
        expect(command?.environment).toEqual({ NODE_OPTIONS: nodeOptions });
        expect(command?.programArguments).toEqual(programArguments);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );
});
