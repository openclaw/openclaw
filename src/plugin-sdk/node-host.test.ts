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

async function createHost(executable: string, native = false) {
  const binDir = tempDirs.make(`openclaw-node-host-${executable}-`);
  const barePath = path.join(binDir, executable);
  const commandPath = path.join(binDir, `${executable}.cmd`);
  if (native) {
    await fs.copyFile(process.execPath, barePath);
  } else {
    await fs.writeFile(barePath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.writeFile(commandPath, "@echo off\r\nexit /b 0\r\n", "utf8");
    if (process.platform !== "win32") {
      await fs.chmod(barePath, 0o755);
    }
  }
  return { barePath, binDir, commandPath };
}

it.runIf(process.platform === "win32").each([true, false])(
  "preserves an explicit includeExtensionless=%s Windows override",
  async (includeExtensionless) => {
    const executable = "custom-host";
    const { barePath, binDir } = await createHost(executable, !includeExtensionless);
    expect(resolve(executable, binDir, "direct", includeExtensionless)).toEqual(
      includeExtensionless ? { executable: barePath } : undefined,
    );
  },
);

it.runIf(process.platform === "win32").each(["direct", "fallback", "prefer"] as const)(
  "falls back to a bare-only Windows host for %s",
  async (strategy) => {
    const { barePath, binDir } = await createHost(`bare-${strategy}`, true);
    expect(resolve(`bare-${strategy}`, binDir, strategy, undefined, ".CMD;.EXE")).toEqual({
      executable: barePath,
    });
  },
);

it.runIf(process.platform === "win32").each(["direct", "fallback", "prefer"] as const)(
  "prefers a later Windows PATHEXT launcher over an earlier bare shim for %s",
  async (strategy) => {
    const { binDir: bareDir } = await createHost(`later-${strategy}`, true);
    const { binDir: launcherDir, commandPath } = await createHost(`later-${strategy}`);
    const pathEnv = `${bareDir};${launcherDir}`;
    expect(resolve(`later-${strategy}`, pathEnv, strategy)).toEqual({ executable: commandPath });
  },
);

it.runIf(process.platform !== "win32")(
  "keeps the extensionless npm launcher on POSIX",
  async () => {
    const { barePath, binDir } = await createHost("codex");
    expect(resolve("codex", binDir)).toEqual({ executable: barePath });
  },
);
