import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const ripgrep = parse(readFileSync(".github/actions/setup-ripgrep/action.yml", "utf8"));
const browser = parse(readFileSync(".github/actions/setup-playwright-chromium/action.yml", "utf8"));

describe.skipIf(process.platform === "win32")("CI browser and grep setup", () => {
  it.each([true, false])("reuses runner rg=%s and refuses corrupt downloads", (installed) => {
    const root = tempDirs.make("openclaw-grep-setup-");
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    const githubPath = path.join(root, "github-path");
    writeFileSync(githubPath, "");
    // Isolate PATH so a developer's rg cannot hide the cold path.
    for (const command of ["mktemp", "tar"]) {
      const location = spawnSync("/bin/bash", ["-c", `command -v ${command}`], {
        encoding: "utf8",
      }).stdout.trim();
      symlinkSync(location, path.join(bin, command));
    }
    if (process.platform === "darwin") {
      // macOS's sha256sum is absent or BSD-only; shasum owns the same byte check.
      writeFileSync(path.join(bin, "sha256sum"), "#!/bin/bash\nexec /usr/bin/shasum -a 256 -c\n", {
        mode: 0o755,
      });
    } else {
      const checksumTool = spawnSync("/bin/bash", ["-c", "command -v sha256sum"], {
        encoding: "utf8",
      }).stdout.trim();
      symlinkSync(checksumTool, path.join(bin, "sha256sum"));
    }
    writeFileSync(
      path.join(bin, "curl"),
      '#!/bin/bash\nwhile [[ "$1" != "--output" ]]; do shift; done\nshift\nprintf corrupt > "$1"\n',
      { mode: 0o755 },
    );
    if (installed) {
      writeFileSync(path.join(bin, "rg"), "#!/bin/bash\necho existing-rg\n", { mode: 0o755 });
    }
    const result = spawnSync("/bin/bash", ["-euo", "pipefail", "-c", ripgrep.runs.steps[0].run], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: bin,
        RUNNER_OS: "Linux",
        RUNNER_ARCH: "X64",
        RUNNER_TEMP: root,
        GITHUB_PATH: githubPath,
      },
    });
    if (installed) {
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("existing-rg");
    } else {
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("FAILED");
    }
    expect(readFileSync(githubPath, "utf8")).toBe("");
  });

  it.each(["X64", "ARM64"])("keys Chromium by installed target version and %s", (arch) => {
    const root = tempDirs.make("openclaw-browser-cache-");
    const packageDir = path.join(root, "ui/node_modules/playwright");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(path.join(root, "ui/package.json"), '{"devDependencies":{"playwright":"*"}}');
    writeFileSync(path.join(packageDir, "package.json"), '{"version":"1.62.1"}');
    const output = path.join(root, "github-output");
    const result = spawnSync("/bin/bash", ["-euo", "pipefail", "-c", browser.runs.steps[0].run], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CACHE_MODE: "restore",
        RUNNER_OS: "Linux",
        RUNNER_ARCH: arch,
        GITHUB_OUTPUT: output,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(`key=Linux-${arch}-playwright-chromium-1.62.1\n`);
  });
});
