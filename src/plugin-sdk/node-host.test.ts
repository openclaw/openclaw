import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearExecutablePathCache } from "../infra/executable-path.js";
import { resolveNodeHostExecutable } from "./node-host.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(clearExecutablePathCache);

function resolve(
  executable: string,
  pathEnv: string,
  strategy: "direct" | "fallback" | "prefer" = "direct",
  includeExtensionless?: boolean,
  pathext = ".CMD",
) {
  return resolveNodeHostExecutable(executable, {
    env: { PATH: pathEnv, PATHEXT: pathext },
    pathEnv,
    strategy,
    ...(includeExtensionless === undefined ? {} : { includeExtensionless }),
  });
}

async function createNpmShimPair(executable: string) {
  const binDir = tempDirs.make(`openclaw-node-host-${executable}-`);
  const barePath = path.join(binDir, executable);
  const commandPath = path.join(binDir, `${executable}.cmd`);
  await fs.writeFile(barePath, "#!/bin/sh\nexit 0\n", "utf8");
  await fs.writeFile(commandPath, "@echo off\r\nexit /b 0\r\n", "utf8");
  if (process.platform !== "win32") {
    await fs.chmod(barePath, 0o755);
  }
  return { barePath, binDir, commandPath };
}

async function createBareNativeHost(executable: string) {
  const binDir = tempDirs.make(`openclaw-node-host-${executable}-`);
  const barePath = path.join(binDir, executable);
  await fs.copyFile(process.execPath, barePath);
  return { barePath, binDir };
}

it.runIf(process.platform === "win32").each([
  ["codex", "fallback"],
  ["claude", "prefer"],
  ["opencode", "fallback"],
  ["pi", "direct"],
] as const)("selects the Windows npm launcher for the %s catalog", async (executable, strategy) => {
  const { binDir, commandPath } = await createNpmShimPair(executable);
  expect(resolve(executable, binDir, strategy)).toEqual({ executable: commandPath });
});

it.runIf(process.platform === "win32").each([true, false])(
  "preserves an explicit includeExtensionless=%s Windows override",
  async (includeExtensionless) => {
    const executable = "custom-host";
    const { barePath, binDir } = await (includeExtensionless
      ? createNpmShimPair(executable)
      : createBareNativeHost(executable));
    expect(resolve(executable, binDir, "direct", includeExtensionless)).toEqual(
      includeExtensionless ? { executable: barePath } : undefined,
    );
  },
);

it.runIf(process.platform === "win32").each([["direct"], ["fallback"], ["prefer"]] as const)(
  "falls back to a bare-only Windows host for %s",
  async (strategy) => {
    const { barePath, binDir } = await createBareNativeHost(`bare-${strategy}`);
    expect(resolve(`bare-${strategy}`, binDir, strategy, undefined, ".CMD;.EXE")).toEqual({
      executable: barePath,
    });
  },
);

it.runIf(process.platform === "win32").each([["direct"], ["fallback"], ["prefer"]] as const)(
  "prefers a later Windows PATHEXT launcher over an earlier bare shim for %s",
  async (strategy) => {
    const { binDir: bareDir } = await createBareNativeHost(`later-${strategy}`);
    const { binDir: launcherDir, commandPath } = await createNpmShimPair(`later-${strategy}`);
    const pathEnv = `${bareDir};${launcherDir}`;
    expect(resolve(`later-${strategy}`, pathEnv, strategy)).toEqual({ executable: commandPath });
  },
);

it.runIf(process.platform !== "win32")(
  "keeps the extensionless npm launcher on POSIX",
  async () => {
    const { barePath, binDir } = await createNpmShimPair("codex");
    expect(resolve("codex", binDir)).toEqual({ executable: barePath });
  },
);
