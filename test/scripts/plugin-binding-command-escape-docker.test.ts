import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import { join } from "node:path";
import * as stringDecoder from "node:string_decoder";
import vm from "node:vm";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = "scripts/e2e/plugin-binding-command-escape-docker.sh";
const script = fs.readFileSync(SCRIPT_PATH, "utf8");
const parser = script.match(/if ! node - "\$RUN_LOG" <<'NODE'\n(?<parser>[\s\S]*?)\nNODE\nthen/u)
  ?.groups?.parser;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runParser(log: string, maxReadBytes = Infinity) {
  assert(parser, `failed to extract embedded log parser from ${SCRIPT_PATH}`);
  const logPath = join(tempDirs.make("openclaw-plugin-binding-log-proof-"), "vitest.log");
  const errors: string[] = [];
  const readSizes: number[] = [];
  const exit = Object.assign(new Error("simulated process exit"), { status: 0 });
  fs.writeFileSync(logPath, log);
  const fsProxy = {
    ...fs,
    readSync(...args: [number, NodeJS.ArrayBufferView, number, number, number | null]) {
      args[3] = Math.min(args[3], maxReadBytes);
      const bytesRead = fs.readSync(...args);
      readSizes.push(bytesRead);
      return bytesRead;
    },
  };
  const dependencies = new Map<string, unknown>([
    ["node:fs", fsProxy],
    ["node:string_decoder", stringDecoder],
  ]);
  try {
    vm.runInNewContext(parser, {
      Buffer,
      console: {
        error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
      },
      process: {
        argv: ["node", "-", logPath],
        exit: (code = 0) => {
          exit.status = code;
          throw exit;
        },
      },
      require: (specifier: string) => {
        assert(dependencies.has(specifier), `unexpected parser dependency: ${specifier}`);
        return dependencies.get(specifier);
      },
    });
  } catch (error) {
    if (error !== exit) {
      throw error;
    }
  }
  return { errors, readSizes, status: exit.status };
}

it("runs the aggregate main suite and dedicated files after the suite split", () => {
  for (const fragment of [
    "if [[ -f src/auto-reply/reply/dispatch-from-config.lifecycle.test.ts ]]",
    "src/auto-reply/reply/dispatch-from-config.delivery.test.ts",
    "src/auto-reply/reply/dispatch-from-config.lifecycle.test.ts",
    "src/auto-reply/reply/dispatch-from-config.test.ts",
    'node scripts/run-vitest.mjs "${test_files[@]}"',
  ]) {
    expect(script).toContain(fragment);
  }
});

it("aggregates split summaries across the complete log with bounded partial reads", () => {
  const noise = "not a summary\n".repeat(6000);
  const result = runParser(
    `\u001B[32m Tests  2 passed\u001B[39m\n${noise}\u{1F98A}${noise}\u001B[32m Tests  1 passed\u001B[39m\n`,
    3,
  );
  expect(Buffer.byteLength(noise)).toBeGreaterThan(65536);
  expect(result).toMatchObject({ status: 0, errors: [] });
  expect(result.readSizes.length).toBeGreaterThan(2);
  expect(result.readSizes.every((size) => size <= 3)).toBe(true);
});

it("accepts one aggregate summary", () => {
  expect(runParser(" Tests  3 passed | 4 skipped (7)\n").status).toBe(0);
});

it.each([
  [2, "2 summaries totaling 2"],
  [3, "3 summaries"],
])("rejects %i summaries with diagnostic %s", (count, diagnostic) => {
  const result = runParser(" Tests  1 passed\n".repeat(count));
  expect(result.status).toBe(1);
  expect(result.errors.join("\n")).toContain(diagnostic);
});
