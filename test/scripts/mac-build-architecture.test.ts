import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(process.platform === "win32")("per-architecture macOS packaging", () => {
  it.each(["package-mac-app.sh", "package-mac-dist.sh"])(
    "%s rejects universal and unsupported requests before building",
    (script) => {
      for (const arch of ["all", "arm64 x86_64", "riscv64"]) {
        const result = spawnSync("/bin/bash", [path.resolve("scripts", script)], {
          encoding: "utf8",
          env: { PATH: process.env.PATH, BUILD_ARCHS: arch },
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("per-architecture artifacts");
        expect(result.stdout).not.toContain("Building");
      }
    },
  );

  it.each(["arm64", "x86_64"])("selects %s explicitly or from the host", (arch) => {
    const script = path.join(dirs.make("mac-build-arch-"), "select.sh");
    writeFileSync(
      script,
      `${readFileSync("scripts/lib/mac-app-bundle.sh", "utf8")}\nuname() { printf '%s\\n' '${arch}'; }\nresolve_mac_build_architecture`,
    );
    for (const selected of [arch, ""]) {
      const result = spawnSync("/bin/bash", [script], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, BUILD_ARCHS: selected },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(arch);
    }
  });
});
