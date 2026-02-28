#!/usr/bin/env node
/**
 * Reachability-Bound Ungated Scan Runner
 * Loads all ontology packs and scans for ungated irreversible primitives
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import type { UngateScanResult } from "./reachability-ungated-scan.js";
import {
  runReachabilityUngateScan,
  formatUngateScanReport,
} from "./reachability-ungated-scan.js";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");

interface OntologyPack {
  pack_id: string;
  contracts: Array<{
    contract_id: string;
    risk_class: string;
    deny_by_default?: boolean;
    needs_confirmation?: boolean;
  }>;
}

async function loadOntologyPacks(): Promise<OntologyPack[]> {
  const packFiles = [
    "NODE_INVOKE.json",
    "TOOL_DISPATCH_GATE.json",
    "FILE_SYSTEM_OPS.json",
    "SHELL_EXEC.json",
    "CRON_SCHEDULE.json",
    "SUBAGENT_SPAWN.json",
    "MESSAGE_EMIT.json",
    "BROWSER_AUTOMATE.json",
    "CANVAS_UI.json",
    "MEDIA_GENERATE.json",
    "MEMORY_MODIFY.json",
    "NETWORK_IO.json",
  ];

  const packs: OntologyPack[] = [];

  for (const file of packFiles) {
    try {
      const packPath = resolve(__dirname, "..", "..", "ontology-packs", file);
      const content = readFileSync(packPath, "utf-8");
      const pack = JSON.parse(content) as OntologyPack;
      packs.push(pack);
    } catch (err) {
      console.warn(`⚠️  Failed to load pack ${file}:`, String(err));
    }
  }

  return packs;
}

async function main() {
  try {
    console.log(
      "Loading ontology packs for Reachability-Bound Ungated Scan...\n",
    );

    const packs = await loadOntologyPacks();
    console.log(`Loaded ${packs.length} ontology packs\n`);

    console.log("Running scan...\n");
    const result = await runReachabilityUngateScan(packs);

    // Print formatted report
    console.log(formatUngateScanReport(result));

    // Exit with appropriate code
    process.exit(result.passCondition ? 0 : 1);
  } catch (error) {
    console.error("Fatal error running scan:", error);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
