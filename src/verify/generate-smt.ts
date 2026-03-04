#!/usr/bin/env tsx
/**
 * CLI entry point: Generate SMT-LIB2 model files from OpenClaw source.
 *
 * Usage:
 *   npx tsx src/verify/generate-smt.ts [--output-dir ./verify-output] [--verify]
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { ParsedAll } from "./types.js";
import { emitOwnerOnlySmt2 } from "./emit-smt/owner-only.js";
import { emitPipelineSmt2 } from "./emit-smt/pipeline.js";
import { emitProfilesSmt2 } from "./emit-smt/profiles.js";
import { emitAllSmt2, copyPropertyFiles } from "./emit-smt/properties.js";
import { emitSubagentSmt2 } from "./emit-smt/subagent.js";
import { emitToolsSmt2 } from "./emit-smt/tools.js";
import { parsePipeline } from "./parse-pipeline.js";
import { parsePolicies } from "./parse-policies.js";
import { parseToolCatalog } from "./parse-tools.js";

function parseArgs(): { outputDir: string; verify: boolean; srcDir: string; refDir: string } {
  const args = process.argv.slice(2);
  let outputDir = "./verify-output";
  let verify = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output-dir" && args[i + 1]) {
      outputDir = args[++i];
    } else if (args[i] === "--verify") {
      verify = true;
    }
  }

  // Resolve paths relative to project root
  const projectRoot = path.resolve(import.meta.dirname ?? __dirname, "../..");
  const srcDir = path.join(projectRoot, "src");
  const refDir = path.resolve(projectRoot, "../openclaw-tool-policy-z3");

  return { outputDir: path.resolve(outputDir), verify, srcDir, refDir };
}

function main() {
  const { outputDir, verify, srcDir, refDir } = parseArgs();

  console.log("=== OpenClaw Tool Policy SMT Generator ===");
  console.log(`Source dir: ${srcDir}`);
  console.log(`Output dir: ${outputDir}`);
  console.log();

  // 1. Parse source files
  console.log("--- Parsing source files ---");
  const catalog = parseToolCatalog(srcDir);
  const policies = parsePolicies(srcDir);
  const pipeline = parsePipeline(srcDir);
  const data: ParsedAll = { catalog, policies, pipeline };
  console.log();

  // 2. Generate SMT files
  console.log("--- Generating SMT-LIB2 files ---");
  const modelDir = path.join(outputDir, "model");
  fs.mkdirSync(modelDir, { recursive: true });

  const files: Array<{ name: string; content: string }> = [
    { name: "tools.smt2", content: emitToolsSmt2(data) },
    { name: "pipeline.smt2", content: emitPipelineSmt2(data) },
    { name: "profiles.smt2", content: emitProfilesSmt2(data) },
    { name: "owner-only.smt2", content: emitOwnerOnlySmt2(data) },
    { name: "subagent.smt2", content: emitSubagentSmt2(data) },
    { name: "all.smt2", content: emitAllSmt2() },
  ];

  for (const file of files) {
    const filePath = path.join(modelDir, file.name);
    fs.writeFileSync(filePath, file.content);
    console.log(`  Written: ${filePath}`);
  }

  // 3. Copy property files
  console.log();
  console.log("--- Copying property files ---");
  if (fs.existsSync(path.join(refDir, "properties"))) {
    copyPropertyFiles(refDir, outputDir);
  } else {
    console.log("  Reference property files not found, skipping copy.");
  }
  console.log();

  // 4. Verify with Z3
  if (verify) {
    console.log("--- Verifying with Z3 ---");
    verifyWithZ3(outputDir);
  }

  console.log("=== Done ===");
}

function verifyWithZ3(outputDir: string) {
  const modelDir = path.join(outputDir, "model");

  // Test individual model files with all.smt2
  const allPath = path.join(modelDir, "all.smt2");
  if (!fs.existsSync(allPath)) {
    console.log("  all.smt2 not found, skipping model verification.");
    return;
  }

  const z3Result = spawnSync("z3", [allPath], {
    encoding: "utf-8",
    cwd: modelDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  console.log("  Model verification output:");
  if (z3Result.stdout) {
    for (const line of z3Result.stdout.trim().split("\n")) {
      console.log(`    ${line}`);
    }
  }
  if (z3Result.stderr) {
    console.log(`    ${z3Result.stderr.trim()}`);
  }

  // Run property checks if available
  const runAll = path.join(outputDir, "properties", "run-all.sh");
  if (fs.existsSync(runAll)) {
    console.log();
    console.log("  Running property verification...");
    const propResult = spawnSync("bash", [runAll], {
      encoding: "utf-8",
      cwd: path.join(outputDir, "properties"),
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (propResult.stdout) {
      console.log(propResult.stdout);
    }
    if (propResult.status !== 0) {
      console.log(`  Property verification had errors:`);
      if (propResult.stderr) {
        console.log(propResult.stderr);
      }
    }
  }
}

main();
