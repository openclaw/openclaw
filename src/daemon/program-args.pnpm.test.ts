import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as windowsEncoding from "../infra/windows-encoding.js";
import { decodeWindowsLauncherScript } from "../infra/windows-launcher-encoding.js";
import { resolveGatewayProgramArguments } from "./program-args.js";
import { stageScheduledTask } from "./schtasks-install.js";
import { readScheduledTaskCommand } from "./schtasks-layout.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function createPnpmInstall(nestedStore: boolean) {
  const home = tempDirs.make("openclaw-pnpm-task-");
  const layout = path.join(home, "pnpm", "global", "5");
  const modules = path.join(layout, "node_modules");
  const store = path.join(nestedStore ? modules : layout, ".pnpm");
  const stableRoot = path.join(modules, "openclaw");
  const writeGeneration = async (version: string) => {
    const root = path.join(store, `openclaw@${version}`, "node_modules", "openclaw");
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "openclaw", version }),
    );
    await fs.writeFile(path.join(root, "openclaw.mjs"), 'import "./dist/index.js";\n');
    await fs.writeFile(path.join(root, "dist", "index.js"), `export default "${version}";\n`);
    return root;
  };
  const originalRoot = await writeGeneration("2026.9.6");
  await fs.mkdir(modules, { recursive: true });
  await fs.writeFile(path.join(layout, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await fs.writeFile(path.join(modules, ".modules.yaml"), "layoutVersion: 5\n");
  await fs.symlink(originalRoot, stableRoot, "junction");
  return { home, modules, stableRoot, originalRoot, writeGeneration };
}

describe("pnpm Scheduled Task entrypoint", () => {
  it.each([
    { layout: "global/5/.pnpm", nestedStore: false, entry: "openclaw.mjs" },
    { layout: "global/5/node_modules/.pnpm", nestedStore: true, entry: "dist/index.js" },
  ])(
    "keeps the saved launcher usable after replacement in $layout",
    async ({ nestedStore, entry }) => {
      const fixture = await createPnpmInstall(nestedStore);
      const runtimePath = path.win32.join("C:\\Program Files", "nodejs", "node.exe");
      const resolved = await resolveGatewayProgramArguments({
        cliEntrypoint: path.join(fixture.originalRoot, entry),
        runtime: "node",
        runtimePath,
        port: 18789,
      });

      // Real filesystem ownership is host-native; the writer receives Windows paths.
      const windowsHome = path.win32.join("C:\\Users", "Fixture User");
      const toWindowsPath = (value: string) =>
        path.win32.join(windowsHome, ...path.relative(fixture.home, value).split(path.sep));
      const programArguments = resolved.programArguments.map((value) =>
        value.startsWith(fixture.home + path.sep) ? toWindowsPath(value) : value,
      );
      const env = {
        HOME: fixture.home,
        USERPROFILE: fixture.home,
        OPENCLAW_STATE_DIR: path.join(fixture.home, "state"),
      };
      vi.spyOn(windowsEncoding, "resolveWindowsOemCodePage").mockReturnValue(437);
      const stdout = new PassThrough();
      try {
        const retiredRoot = await fixture.writeGeneration("2026.9.5");
        const previous = await stageScheduledTask({
          env,
          stdout,
          programArguments: [
            runtimePath,
            toWindowsPath(path.join(retiredRoot, "dist", "index.js")),
            "gateway",
            "--port",
            "18789",
          ],
          environment: { OPENCLAW_SERVICE_KIND: "gateway" },
        });
        await fs.rm(retiredRoot, { recursive: true });

        const { scriptPath } = await stageScheduledTask({
          env,
          stdout,
          programArguments,
          environment: { OPENCLAW_SERVICE_KIND: "gateway" },
        });
        expect(scriptPath).toBe(previous.scriptPath);
        const script = decodeWindowsLauncherScript({ buffer: await fs.readFile(scriptPath) });
        const saved = await readScheduledTaskCommand(env);
        const savedEntry = saved?.programArguments.at(-4);
        expect(saved?.programArguments[0]).toBe(runtimePath);
        expect(savedEntry).toBe(
          path.win32.join(windowsHome, "pnpm/global/5/node_modules/openclaw/dist/index.js"),
        );
        expect(script).toContain(`"${runtimePath}" `);
        expect(script).toContain("--task-supervisor < NUL\r\n");
        expect(script).not.toContain(".pnpm");

        const replacementRoot = await fixture.writeGeneration("2026.9.7");
        await fs.unlink(fixture.stableRoot);
        await fs.symlink(replacementRoot, fixture.stableRoot, "junction");
        await fs.rm(fixture.originalRoot, { recursive: true });

        const savedHostEntry = path.join(
          fixture.home,
          ...path.win32.relative(windowsHome, savedEntry!).split(path.win32.sep),
        );
        await expect(fs.readFile(savedHostEntry, "utf8")).resolves.toBe(
          'export default "2026.9.7";\n',
        );
        expect(decodeWindowsLauncherScript({ buffer: await fs.readFile(scriptPath) })).toBe(script);
      } finally {
        stdout.destroy();
      }
    },
  );

  it.each(["unverified", "unrelated"] as const)(
    "does not redirect to an %s stable package link",
    async (kind) => {
      const fixture = await createPnpmInstall(false);
      if (kind === "unverified") {
        await fs.unlink(path.join(fixture.modules, ".modules.yaml"));
      } else {
        const unrelatedRoot = await fixture.writeGeneration("2026.9.7");
        await fs.unlink(fixture.stableRoot);
        await fs.symlink(unrelatedRoot, fixture.stableRoot, "junction");
      }
      const originalEntry = path.join(fixture.originalRoot, "dist", "index.js");
      const result = await resolveGatewayProgramArguments({
        cliEntrypoint: originalEntry,
        runtime: "node",
        runtimePath: process.execPath,
        port: 18789,
      });
      expect(result.programArguments.at(-4)).toBe(originalEntry);
    },
  );
});
