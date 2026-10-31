import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

it.runIf(process.env.OPENCLAW_TEST_BUN_LAUNCHER === "1" && process.platform === "darwin")(
  "probes SQLite without executing the caller's Bun preload",
  () => {
    const root = temp.make("sqlite-probe-bun-config-");
    const project = path.join(root, "project");
    const scratch = path.join(root, "scratch");
    const marker = path.join(root, "preload-ran");
    const config = path.join(root, "empty.toml");
    const driver = path.join(root, "driver.mjs");
    fs.mkdirSync(project);
    fs.mkdirSync(scratch);
    fs.writeFileSync(config, "");
    fs.writeFileSync(path.join(project, "bunfig.toml"), 'preload = ["./preload.mjs"]\n');
    fs.writeFileSync(
      path.join(project, "preload.mjs"),
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "executed");
console.log("unexpected preload output");
`,
    );
    fs.writeFileSync(
      driver,
      `import { probeBunSqliteLibrary } from ${JSON.stringify(new URL("./bun-sqlite-library-probe.ts", import.meta.url).href)};
console.log(JSON.stringify(probeBunSqliteLibrary("/usr/lib/libsqlite3.dylib")));
`,
    );

    const result = spawnSync(
      process.env.BUN_BIN ?? "bun",
      ["--no-install", "--no-env-file", `--config=${config}`, driver],
      {
        cwd: project,
        env: { TMPDIR: scratch },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      version: expect.stringMatching(/^3\./),
      extensionLoadingSupported: expect.any(Boolean),
    });
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readdirSync(scratch)).toEqual([]);
  },
);
