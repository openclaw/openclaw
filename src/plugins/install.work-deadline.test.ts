import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandOptions } from "../process/exec.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { installPluginFromNpmSpec } from "./install-npm.js";
import { installPluginFromArchive } from "./install-package.js";

const runCommand = vi.hoisted(() => vi.fn());
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: (...args: unknown[]) => runCommand(...args),
}));

describe("plugin update work deadlines", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "plugin-work-deadline" });
    vi.stubEnv("NPM_CONFIG_GLOBALCONFIG", await state.writeText("global-npmrc", ""));
    runCommand.mockReset();
    runCommand.mockImplementation(async (argv: string[], options: CommandOptions) => {
      let stdout = "";
      if (argv[1] === "view") {
        stdout = JSON.stringify({ name: "deadline-fixture", version: "1.0.0" });
      } else if (argv[1] === "install") {
        const cwd = options.cwd!;
        const packageDir = path.join(cwd, "node_modules", "deadline-fixture");
        await fs.mkdir(packageDir, { recursive: true });
        await fs.writeFile(
          path.join(cwd, "package-lock.json"),
          JSON.stringify({
            lockfileVersion: 3,
            packages: {
              "": { dependencies: { "deadline-fixture": "1.0.0" } },
              "node_modules/deadline-fixture": { version: "1.0.0" },
            },
          }),
        );
        await fs.writeFile(
          path.join(packageDir, "package.json"),
          JSON.stringify({
            name: "deadline-fixture",
            version: "1.0.0",
            openclaw: { extensions: ["./index.js"] },
          }),
        );
        await fs.writeFile(
          path.join(packageDir, "openclaw.plugin.json"),
          JSON.stringify({ id: "deadline-fixture", configSchema: { type: "object" } }),
        );
        await fs.writeFile(path.join(packageDir, "index.js"), "export default {};");
      } else {
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
    { mode: "install", timeoutMs: undefined, work: 300_000, planning: 120_000, metadata: 120_000 },
    {
      mode: "update",
      timeoutMs: undefined,
      work: undefined,
      planning: undefined,
      metadata: 120_000,
    },
    { mode: "update", timeoutMs: 37, work: 37, planning: 37, metadata: 60_000 },
  ] as const)(
    "preserves $mode work=$work while metadata stays bounded",
    async ({ mode, timeoutMs, work, planning, metadata }) => {
      const result = await installPluginFromNpmSpec({
        spec: "deadline-fixture@1.0.0",
        expectedPluginId: "deadline-fixture",
        mode,
        timeoutMs,
        npmDir: path.join(state.root, "npm"),
        extensionsDir: path.join(state.root, "extensions"),
        config: {},
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(result.error);
      }
      expect(await fs.readFile(path.join(result.targetDir, "index.js"), "utf8")).toBe(
        "export default {};",
      );
      const calls = runCommand.mock.calls as [string[], CommandOptions][];
      expect(
        calls.filter(([argv]) => argv[1] === "view").map(([, opts]) => opts.timeoutMs),
      ).toEqual([metadata]);
      expect(
        calls
          .filter(([argv]) => argv[1] === "install" && !argv.includes("--package-lock-only"))
          .map(([, opts]) => opts.timeoutMs),
      ).toEqual([work]);
      const plans = calls.filter(([argv]) => argv.includes("--package-lock-only"));
      expect(plans.length).toBeGreaterThan(0);
      expect(plans.every(([, opts]) => opts.timeoutMs === planning)).toBe(true);
    },
  );
  it.each([
    { mode: "install", timeoutMs: undefined, work: 300_000 },
    { mode: "update", timeoutMs: undefined, work: undefined },
    { mode: "update", timeoutMs: 500, work: 500 },
  ] as const)(
    "keeps $mode archive work policy through extraction and dependency installation",
    async ({ mode, timeoutMs, work }) => {
      const zip = new JSZip();
      zip.file(
        "package.json",
        JSON.stringify({
          name: "archive-fixture",
          version: "1.0.0",
          openclaw: { extensions: ["./index.js"] },
          dependencies: { "deadline-fixture": "1.0.0" },
        }),
      );
      zip.file(
        "openclaw.plugin.json",
        JSON.stringify({ id: "archive-fixture", configSchema: { type: "object" } }),
      );
      zip.file("index.js", "export default {};");
      const archivePath = path.join(state.root, "fixture.zip");
      await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
      const result = await installPluginFromArchive({
        archivePath,
        mode,
        timeoutMs,
        extensionsDir: path.join(state.root, "extensions"),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(result.error);
      }
      expect(await fs.readFile(path.join(result.targetDir, "index.js"), "utf8")).toBe(
        "export default {};",
      );
      expect(runCommand.mock.calls.map(([, opts]) => opts.timeoutMs)).toEqual([work]);
    },
  );
});
