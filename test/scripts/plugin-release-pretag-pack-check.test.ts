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

it("preserves timeout failure semantics without child details", async () => {
  command.mockResolvedValueOnce(0).mockRejectedValueOnce(failure("ETIMEDOUT"));
  await expect(checkPack(repoDir)).rejects.toMatchObject({
    code: "ETIMEDOUT",
    message:
      "npm pack for @openclaw/demo-plugin timed out after 600000ms: bash scripts/plugin-npm-publish.sh --pack-dry-run extensions/demo-plugin",
  });
});

it("maps nonnumeric failures to the CLI failure status", () => {
  expect(pluginReleasePretagExitCode(failure("ETIMEDOUT"))).toBe(1);
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
