#!/usr/bin/env npx tsx
/**
 * Generate a JSON map of operator1 doc slug → last git commit date.
 * Run before dev/build to keep "last updated" dates accurate.
 *
 * Output: ui-next/src/lib/docs-dates.generated.json
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const docsDir = path.resolve(import.meta.dirname, "../../docs/operator1");
const outFile = path.resolve(import.meta.dirname, "../src/lib/docs-dates.generated.json");

const dates: Record<string, string> = {};

for (const file of fs.readdirSync(docsDir).filter((f) => f.endsWith(".md"))) {
  const slug = file.replace(/\.md$/, "");
  try {
    const date = execSync(`git log -1 --format="%cs" -- "${path.join(docsDir, file)}"`, {
      encoding: "utf-8",
    }).trim();
    if (date) {
      dates[slug] = date;
    }
  } catch {
    // skip files with no git history
  }
}

fs.writeFileSync(outFile, JSON.stringify(dates, null, 2) + "\n");
console.log(
  `Wrote ${Object.keys(dates).length} doc dates to ${path.relative(process.cwd(), outFile)}`,
);
