import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeScriptEnv } from "../../cli-invocation.mjs";
import { BUN_SQLITE_LIBRARY_PROBE_SOURCE } from "./bun-sqlite-library-probe.generated.js";
import { runtimeProcessScriptEntrypoints } from "./runtime-process-manifest.js";
import { materializeRuntimeProcessScriptFile } from "./runtime-process-script-file.js";

export type SqliteLibraryProbe = { version: string; extensionLoadingSupported: boolean };

/** Each candidate gets a fresh process because Bun's SQLite selection is one-shot. */
export function probeBunSqliteLibrary(candidate: string): SqliteLibraryProbe {
  const script = materializeRuntimeProcessScriptFile({
    fileName: runtimeProcessScriptEntrypoints.bunSqliteLibraryProbe.fileName,
    source: BUN_SQLITE_LIBRARY_PROBE_SOURCE,
  });
  try {
    const scriptPath = fileURLToPath(script.url);
    const directory = path.dirname(scriptPath);
    const configPath = path.join(directory, "bunfig.toml");
    // Project preloads can open SQLite or write to stdout before the fixed probe runs.
    fs.writeFileSync(configPath, "", { mode: 0o600, flag: "wx" });
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
      if (process.env[key]) {
        env[key] = process.env[key];
      }
    }
    const result = spawnSync(
      process.execPath,
      [
        "--no-install",
        "--no-env-file",
        `--config=${configPath}`,
        scriptPath,
        path.resolve(candidate),
      ],
      {
        cwd: directory,
        env: resolveRuntimeScriptEnv(env),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
        killSignal: "SIGKILL",
        maxBuffer: 4_096,
      },
    );
    if (result.error) {
      throw result.error;
    }
    let facts: unknown;
    try {
      facts = JSON.parse(result.stdout);
    } catch {
      throw new Error("SQLite library probe returned invalid output");
    }
    if (
      typeof facts !== "object" ||
      facts === null ||
      Array.isArray(facts) ||
      !("protocol" in facts) ||
      facts.protocol !== 1
    ) {
      throw new Error("SQLite library probe returned invalid output");
    }
    if (result.status !== 0) {
      throw new Error(
        "error" in facts && typeof facts.error === "string"
          ? facts.error.slice(0, 512)
          : `SQLite library probe failed (${result.signal ?? result.status})`,
      );
    }
    if (
      !("version" in facts) ||
      typeof facts.version !== "string" ||
      facts.version.length > 64 ||
      !("extensionLoadingSupported" in facts) ||
      typeof facts.extensionLoadingSupported !== "boolean"
    ) {
      throw new Error("SQLite library probe returned invalid output");
    }
    return { version: facts.version, extensionLoadingSupported: facts.extensionLoadingSupported };
  } finally {
    script.dispose();
  }
}
