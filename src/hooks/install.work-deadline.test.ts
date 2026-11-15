import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandOptions } from "../process/exec.js";
import { npmCommandArgs } from "../test-utils/npm-command.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { installHooksFromNpmSpec } from "./install.js";

const runCommand = vi.hoisted(() => vi.fn());
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: (...args: unknown[]) => runCommand(...args),
}));

describe("hook update work deadlines", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "hook-work-deadline" });
    vi.stubEnv("NPM_CONFIG_GLOBALCONFIG", await state.writeText("global-npmrc", ""));
    await state.writeJson("package/package.json", {
      name: "deadline-hooks",
      version: "1.0.0",
      openclaw: { hooks: ["./hooks/deadline"] },
      dependencies: { "deadline-fixture": "1.0.0" },
    });
    await state.writeText(
      "package/hooks/deadline/HOOK.md",
      '---\nname: deadline\ndescription: Deadline fixture\nmetadata: {"openclaw":{"events":["command:new"]}}\n---\n# Deadline fixture\n',
    );
    await state.writeText("package/hooks/deadline/handler.ts", "export default async () => {};\n");
    const archivePath = path.join(state.root, "fixture.tgz");
    await tar.c({ cwd: state.stateDir, file: archivePath, gzip: true }, ["package"]);
    runCommand.mockReset();
    runCommand.mockImplementation(async (argv: string[], options: CommandOptions) => {
      let stdout = "";
      if (npmCommandArgs(argv)?.[0] === "pack") {
        await fs.copyFile(archivePath, path.join(options.cwd!, "fixture.tgz"));
        stdout = JSON.stringify([
          { name: "deadline-hooks", version: "1.0.0", filename: "fixture.tgz" },
        ]);
      } else if (npmCommandArgs(argv)?.[0] !== "install") {
        throw new Error(`Unexpected fixture command: ${argv.join(" ")}`);
      }
      return { code: 0, stdout, stderr: "", signal: null, killed: false, termination: "exit" };
    });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await state.cleanup();
  });

  it.each([
    { mode: "install", timeoutMs: undefined, work: 300_000 },
    { mode: "update", timeoutMs: undefined, work: undefined },
    { mode: "update", timeoutMs: 500, work: 500 },
  ] as const)(
    "keeps $mode work policy through pack, extraction, and dependency installation",
    async ({ mode, timeoutMs, work }) => {
      const result = await installHooksFromNpmSpec({
        spec: "deadline-hooks@1.0.0",
        hooksDir: path.join(state.root, "hooks"),
        mode,
        timeoutMs,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(result.error);
      }
      expect(
        await fs.readFile(path.join(result.targetDir, "hooks", "deadline", "handler.ts"), "utf8"),
      ).toBe("export default async () => {};\n");
      expect(
        runCommand.mock.calls.map(([argv, opts]) => [npmCommandArgs(argv)?.[0], opts.timeoutMs]),
      ).toEqual([
        ["pack", work],
        ["install", work],
      ]);
    },
  );
});
