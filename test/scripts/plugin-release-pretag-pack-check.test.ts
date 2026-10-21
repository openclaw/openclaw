import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  pluginReleasePretagExitCode,
  runPluginReleasePretagPackCheck as checkPack,
} from "../../scripts/plugin-release-pretag-pack-check.ts";
import { writePublishablePluginFixture } from "../helpers/publishable-plugin-fixture.js";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "../helpers/temp-dir.js";
import { writeJsonFile } from "../helpers/temp-repo.js";

const { command } = vi.hoisted(() => ({ command: vi.fn() }));
const failure = (code: string, processTreeState?: string) =>
  Object.assign(new Error("secret-marker"), { code, processTreeState });

vi.mock(import("../../scripts/lib/managed-child-process.mts"), async (importOriginal) => ({
  ...(await importOriginal()),
  runManagedCommand: command,
}));

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
  command.mockReset();
});

let repoDir: string;
beforeEach(() => {
  repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-pretag-pack-");
  writeJsonFile(join(repoDir, "package.json"), { name: "openclaw-test-root", type: "module" });
  writePublishablePluginFixture(repoDir, {
    version: "2026.4.10",
    publishTo: "both",
  });
});

it("gives each selected runtime build its own managed deadline", async () => {
  writePublishablePluginFixture(repoDir, {
    extensionId: "second-plugin",
    version: "2026.4.11",
    publishTo: "both",
  });
  command.mockResolvedValue(0);

  await checkPack(repoDir, { timeoutMs: 321 });

  expect(command).toHaveBeenCalledTimes(6);
  for (const [index, id] of [
    [0, "demo"],
    [3, "second"],
  ] as const) {
    expect(command.mock.calls[index]?.[0]).toMatchObject({
      args: expect.arrayContaining(["--package", `extensions/${id}-plugin`]),
      timeoutMs: 321,
    });
  }
});

it.each([
  [
    7,
    "plugin runtime build for @openclaw/demo-plugin failed with exit code 7: node --import tsx scripts/check-plugin-npm-runtime-builds.mts --package extensions/demo-plugin",
  ],
  [
    "ETIMEDOUT",
    "npm pack for @openclaw/demo-plugin timed out after 600000ms: bash scripts/plugin-npm-publish.sh --pack-dry-run extensions/demo-plugin",
  ],
])("preserves %s failure semantics without child details", async (code, message) => {
  if (typeof code === "number") {
    command.mockResolvedValueOnce(code);
  } else {
    command.mockResolvedValueOnce(0).mockRejectedValueOnce(failure(code));
  }
  await expect(checkPack(repoDir)).rejects.toMatchObject({ code, message });
});

it("preserves managed cancellation statuses at the CLI boundary", () => {
  expect(
    [130, 143, "ETIMEDOUT"].map((code) =>
      pluginReleasePretagExitCode(Object.assign(new Error("interrupted"), { code })),
    ),
  ).toEqual([130, 143, 1]);
});

it.each(["live", "terminated"] as const)(
  "retains temporary inputs only when managed cleanup reports %s work",
  async (processTreeState) => {
    command
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(failure("EPROCESSGROUP_CLEANUP_FAILED", processTreeState));
    await expect(checkPack(repoDir)).rejects.toMatchObject({
      code: "EPROCESSGROUP_CLEANUP_FAILED",
      processTreeState,
    });
    const options = command.mock.calls[1]?.[0] as {
      env: NodeJS.ProcessEnv;
    };
    const wrapperDir = options.env.PATH!.split(delimiter)[0]!;
    const tempRoot = dirname(wrapperDir);
    tempDirs.push(tempRoot);
    expect(existsSync(tempRoot)).toBe(processTreeState !== "terminated");
  },
);
