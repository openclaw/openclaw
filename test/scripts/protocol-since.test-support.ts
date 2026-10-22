import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { quoteShell, runWorkflowShellScript, TSX_IMPORT } from "./ci-workflow.test-support.js";

const TYPESCRIPT_NODE_MODULES = path.dirname(
  path.dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))),
);
function writeFixture(file: string, contents: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}
function writeJson(file: string, value: unknown) {
  writeFixture(file, JSON.stringify(value));
}

export function runProtocolSinceFixture(checkout: string, baseSha: string) {
  for (const scriptPath of [
    "packages/normalization-core/src/record-coerce.ts",
    "scripts/check-protocol-since.mts",
    "scripts/lib/native-typescript.mts",
    "scripts/lib/repo-root.mjs",
    "scripts/lib/ts-guard-utils.mts",
  ]) {
    const target = path.join(checkout, scriptPath);
    writeFixture(target, readFileSync(scriptPath, "utf8"));
  }
  writeJson(path.join(checkout, "tsconfig.json"), {
    compilerOptions: {
      paths: {
        "@openclaw/normalization-core/record-coerce": [
          "./packages/normalization-core/src/record-coerce.ts",
        ],
      },
    },
  });
  const nodeModules = path.join(checkout, "node_modules");
  if (!existsSync(nodeModules)) {
    symlinkSync(TYPESCRIPT_NODE_MODULES, nodeModules, "dir");
  }
  return runWorkflowShellScript(
    `${quoteShell(process.execPath)} --import ${quoteShell(TSX_IMPORT)} scripts/check-protocol-since.mts`,
    { cwd: checkout, env: { ...process.env, PROTOCOL_SINCE_BASE_SHA: baseSha } },
  );
}
