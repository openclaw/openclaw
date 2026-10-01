import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandOptions } from "../process/exec.js";
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
    const packageDir = path.join(state.root, "package");
    await fs.mkdir(path.join(packageDir, "hooks", "deadline"), { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "deadline-hooks",
        version: "1.0.0",
        openclaw: { hooks: ["./hooks/deadline"] },
        dependencies: { "deadline-fixture": "1.0.0" },
      }),
    );
    await fs.writeFile(
      path.join(packageDir, "hooks", "deadline", "HOOK.md"),
      '---\nname: deadline\ndescription: Deadline fixture\nmetadata: {"openclaw":{"events":["command:new"]}}\n---\n# Deadline fixture\n',
    );
    await fs.writeFile(
      path.join(packageDir, "hooks", "deadline", "handler.ts"),
      "export default async () => {};\n",
    );
    const archivePath = path.join(state.root, "fixture.tgz");
    await tar.c({ cwd: state.root, file: archivePath, gzip: true }, ["package"]);
    runCommand.mockReset();
    runCommand.mockImplementation(async (argv: string[], options: CommandOptions) => {
      let stdout = "";
      if (argv[1] === "pack") {
        await fs.copyFile(archivePath, path.join(options.cwd!, "fixture.tgz"));
        stdout = JSON.stringify([
          { name: "deadline-hooks", version: "1.0.0", filename: "fixture.tgz" },
        ]);
      } else if (argv[1] !== "install") {
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
      expect(runCommand.mock.calls.map(([argv, opts]) => [argv[1], opts.timeoutMs])).toEqual([
        ["pack", work],
        ["install", work],
      ]);
    },
  );
});
