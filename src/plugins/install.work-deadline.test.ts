import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CommandOptions } from "../process/exec.js";
import { npmCommandArgs } from "../test-utils/npm-command.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { installPluginFromNpmSpec } from "./install-npm.js";
import { installPluginFromArchive } from "./install-package.js";
import { writeArtifacts } from "./public-surface.test-support.js";

const runCommand = vi.hoisted(() => vi.fn());
const fixtureId = "deadline-fixture";
const source = "export default {};";
const packageFiles = (name: string, dependencies?: Record<string, string>) => ({
  "package.json": JSON.stringify({
    name,
    version: "1.0.0",
    openclaw: { extensions: ["./index.js"] },
    dependencies,
  }),
  "openclaw.plugin.json": JSON.stringify({ id: name, configSchema: { type: "object" } }),
  "index.js": source,
});
const commandTimeouts = (command: "view" | "install" | "plan") =>
  (runCommand.mock.calls as [string[], CommandOptions][])
    .filter(([argv]) => {
      const plan = argv.includes("--package-lock-only");
      return command === "plan"
        ? plan
        : npmCommandArgs(argv)?.[0] === command && (command === "view" || !plan);
    })
    .map(([, opts]) => opts.timeoutMs);

vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: (...args: unknown[]) => runCommand(...args),
}));

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "plugin-work-deadline" });
  vi.stubEnv("NPM_CONFIG_GLOBALCONFIG", await state.writeText("global-npmrc", ""));
  runCommand.mockReset();
  runCommand.mockImplementation(async (argv: string[], options: CommandOptions) => {
    let stdout = "";
    if (npmCommandArgs(argv)?.[0] === "view") {
      stdout = JSON.stringify({ name: fixtureId, version: "1.0.0" });
    } else if (npmCommandArgs(argv)?.[0] === "install") {
      const cwd = options.cwd!;
      const packageDir = path.join(cwd, "node_modules", fixtureId);
      writeArtifacts(cwd, {
        "package-lock.json": {
          lockfileVersion: 3,
          packages: {
            "": { dependencies: { [fixtureId]: "1.0.0" } },
            [`node_modules/${fixtureId}`]: { version: "1.0.0" },
          },
        },
      });
      writeArtifacts(packageDir, packageFiles(fixtureId));
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
  ["install", undefined, 300_000, 120_000, 120_000],
  ["update", undefined, undefined, undefined, 120_000],
  ["update", 37, 37, 37, 60_000],
] as const)(
  "preserves %s work deadlines (timeout=%s, work=%s, planning=%s, metadata=%s)",
  async (mode, timeoutMs, work, planning, metadata) => {
    const result = await installPluginFromNpmSpec({
      spec: "deadline-fixture@1.0.0",
      expectedPluginId: "deadline-fixture",
      mode,
      timeoutMs,
      npmDir: path.join(state.root, "npm"),
      extensionsDir: path.join(state.root, "extensions"),
      config: {},
    });
    expect(result).toMatchObject({ ok: true });
    expect(commandTimeouts("view")).toEqual([metadata]);
    expect(commandTimeouts("install")).toEqual([work]);
    const plans = commandTimeouts("plan");
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.every((timeout) => timeout === planning)).toBe(true);
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
    Object.entries(packageFiles("archive-fixture", { [fixtureId]: "1.0.0" })).forEach(
      ([file, content]) => zip.file(file, content),
    );
    const archivePath = path.join(state.root, "fixture.zip");
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
    const result = await installPluginFromArchive({
      archivePath,
      mode,
      timeoutMs,
      extensionsDir: path.join(state.root, "extensions"),
    });
    expect(result).toMatchObject({ ok: true });
    expect(runCommand.mock.calls.map(([, opts]) => opts.timeoutMs)).toEqual([work]);
  },
);
