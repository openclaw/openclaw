import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../test/helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  { json: false, phase: "command", trace: false },
  { json: true, phase: "command", trace: false },
  { json: true, phase: "finalize", trace: false },
  { json: true, phase: "finalize", trace: true },
] as const)(
  "preserves $phase failure output after installation replacement (JSON: $json, trace: $trace)",
  async ({ json, phase, trace }) => {
    const root = await fs.realpath(dirs.make("openclaw-entry-replacement-"));
    const sources = [
      "src/entry.ts",
      "src/cli/dotenv.ts",
      "src/logging.ts",
      "src/cli/failure-output.ts",
      "src/cli/json-output-mode.ts",
      "src/logging/json-console-line.ts",
      "src/cli/startup-trace.ts",
    ];
    const relocated = new Map(
      sources.map((file, index) => [path.resolve(file), path.join(root, `owner-${index}.mts`)]),
    );
    for (const [source, destination] of relocated) {
      const code = (await fs.readFile(source, "utf8")).replace(
        /(from\s+|import\()"([^"\n]+)"/g,
        (_match, prefix: string, specifier: string) => {
          const target = specifier.startsWith(".")
            ? path.resolve(path.dirname(source), specifier).replace(/\.js$/, ".ts")
            : undefined;
          return `${prefix}${JSON.stringify(target ? pathToFileURL(relocated.get(target) ?? target).href : import.meta.resolve(specifier))}`;
        },
      );
      await fs.writeFile(destination, code);
    }
    const runner = path.join(root, "runner.mts");
    await fs.writeFile(
      runner,
      `
import fs from 'node:fs/promises';
${trace ? "process.argv.push('gateway');" : ""}
const { runMainOrRootHelp } = await import(${JSON.stringify(pathToFileURL(relocated.get(path.resolve("src/entry.ts"))!).href)});
const fail = async () => { throw new Error('original update failure'); };
await runMainOrRootHelp(['node', 'openclaw', 'update', ${json ? "'--json'" : "'--yes'"}], {
  loadRunCli: async () => ({ runCli: async () => {
    await Promise.all(${JSON.stringify([...relocated.values()])}.map(file => fs.rm(file)));
    ${phase === "command" ? "await fail();" : ""}
  }}),
  ${phase === "finalize" ? "finalize: fail," : ""}
});
`,
    );
    const result = await promisify(execFile)(
      process.execPath,
      ["--import", path.resolve("scripts/tsx.mjs"), runner],
      {
        cwd: root,
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
          OPENCLAW_DEBUG: "0",
          OPENCLAW_GATEWAY_STARTUP_TRACE: trace ? "1" : "0",
          NODE_OPTIONS: "",
          VITEST: "",
          VITEST_POOL_ID: "",
          VITEST_WORKER_ID: "",
          TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
        },
      },
    ).then(
      (value) => ({ ...value, code: 0 }),
      (error: unknown) => {
        if (
          !(error instanceof Error) ||
          !("stdout" in error) ||
          !("stderr" in error) ||
          !("code" in error)
        ) {
          throw error;
        }
        return { stdout: String(error.stdout), stderr: String(error.stderr), code: error.code };
      },
    );
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain("original update failure");
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    if (trace) {
      expect(result.stderr).toContain("startup trace: entry.run-main-import");
    }
    if (json) {
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { message: "original update failure" },
      });
    } else {
      expect(result.stdout).toBe("");
    }
  },
);
