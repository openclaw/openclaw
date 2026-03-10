import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const scriptPath = path.resolve(__dirname, "../scripts/install.ps1");
const script = readFileSync(scriptPath, "utf8");
const mainMatch = script.match(/function Main \{([\s\S]*?)\n\}\n\n\[void\]\(Main\)/);

test("scripts/install.ps1 does not hard-exit the host PowerShell process from Main", () => {
  assert.ok(mainMatch?.[1], "could not locate Main() body");
  assert.doesNotMatch(mainMatch[1], /\bexit\s+1\b/);
});

test("scripts/install.ps1 suppresses Main's boolean return value at script entry", () => {
  assert.match(script, /\[void\]\(Main\)/);
});
