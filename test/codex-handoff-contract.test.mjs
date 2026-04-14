import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function finalNonEmptyLine(text) {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .reverse()
    .find((line) => line.trim().length > 0) ?? null;
}

test("openclaw handoff compatibility stays aligned with the shared Codex contract", () => {
  const sharedContract = JSON.parse(read("../Shared Repo Resources/docs/jobapp/codex-model-handoff-contract.v1.json"));
  const agents = read("AGENTS.md");
  const readme = read("README.md");

  assert.equal(sharedContract.rendering.canonicalPrefix, "Model for Codex:");
  assert.equal(sharedContract.allowedValues.length, 8);
  assert.match(agents, /codex-model-handoff-contract\.md/);
  assert.match(readme, /codex-model-handoff-contract\.md/);
  assert.match(agents, /newly issues a live ChatGPT-to-Codex execution handoff/);
  assert.match(readme, /newly issues a live ChatGPT-to-Codex execution handoff/);

  const liveHandoffResponse = [
    "Overview",
    "Completed the repo-local QC updates and one live Codex handoff remains.",
    "Ready-to-Send Primary Prompt for Codex",
    "Audit the remaining shared-contract consumer alignment in the covered openclaw handoff surface and update the matching compatibility test.",
    "Model for Codex: ChatGPT-5.4-Mini medium",
  ].join("\n\n");

  const nonHandoffResponse = [
    "Overview",
    "Completed the repo-local QC updates and no live Codex handoff remains.",
    "Next Steps",
    "none",
  ].join("\n\n");

  assert.equal(finalNonEmptyLine(liveHandoffResponse), "Model for Codex: ChatGPT-5.4-Mini medium");
  assert.equal(nonHandoffResponse.includes("Model for Codex:"), false);
});
