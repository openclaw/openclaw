import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveBrewOpenClawPath } from "./brew.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

describe.skipIf(process.platform === "win32")("Homebrew formula paths", () => {
  it.each(["/opt/homebrew", "/usr/local", "/home/linuxbrew/.linuxbrew"])(
    "recognizes only formula layouts immediately beneath %s",
    async (prefix) => {
      const suffix = "/libexec/lib/node_modules/openclaw";
      const stable = `${prefix}/opt/openclaw-cli${suffix}`;
      await expect(
        resolveBrewOpenClawPath(`${prefix}/Cellar/openclaw-cli/2026.9.4_1${suffix}`),
      ).resolves.toBe(stable);
      await expect(resolveBrewOpenClawPath(stable)).resolves.toBe(stable);
      for (const root of [
        `${prefix}/lib/node_modules/openclaw`,
        `${prefix}/Cellar/openclaw-cli${suffix}`,
        `${prefix}/project/opt/openclaw-cli${suffix}`,
        `${prefix}-other/Cellar/openclaw-cli/2026.9.4${suffix}`,
      ]) {
        await expect(resolveBrewOpenClawPath(root)).resolves.toBeNull();
      }
    },
  );

  it.each(["environment", "brew", "unavailable"])(
    "resolves custom prefixes via %s",
    async (source) => {
      const prefix = dirs.make("homebrew-prefix-");
      const bin = path.join(prefix, "bin");
      await fs.mkdir(bin);
      await fs.writeFile(
        path.join(bin, "brew"),
        '#!/bin/sh\n[ "$1" = "--prefix" ] || exit 9\n' +
          (source === "brew" ? 'printf "%s\\n" "${0%/bin/brew}"\n' : "exit 1\n"),
        { mode: 0o755 },
      );
      vi.stubEnv("PATH", bin);
      vi.stubEnv("HOMEBREW_PREFIX", source === "environment" ? prefix : undefined);
      const suffix = "/libexec/lib/node_modules/openclaw";
      const root = `${prefix}/Cellar/openclaw-cli/2026.9.4${suffix}`;
      await expect(resolveBrewOpenClawPath(root)).resolves.toBe(
        source === "unavailable" ? null : `${prefix}/opt/openclaw-cli${suffix}`,
      );
    },
  );
});
