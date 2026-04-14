import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

function read(relativePath) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

void test("repo-specific QC overlay stays complementary with shared authority", () => {
  const agents = read("AGENTS.md");
  const readme = read("README.md");
  const packageJson = JSON.parse(read("package.json"));

  assert.ok(agents.includes("Repo-specific QC overlay: this file."));
  assert.ok(
    agents.includes(
      "Shared QC authority: `../Shared Repo Resources/docs/jobapp/*` and the corresponding shared scripts in `../Shared Repo Resources/scripts/`.",
    ),
  );
  assert.ok(
    agents.includes(
      "Shared Codex handoff contract: `../Shared Repo Resources/docs/jobapp/codex-model-handoff-contract.md` and `../Shared Repo Resources/docs/jobapp/codex-model-handoff-contract.v1.json`.",
    ),
  );
  assert.ok(
    agents.includes("Keep repo-local QC details here, but do not redefine shared gates, closeout contracts, or remaining-work rules."),
  );
  assert.ok(
    agents.includes(
      "Apply the canonical `Model for Codex:` final line only when a covered openclaw response newly issues a live ChatGPT-to-Codex execution handoff; do not emit it on summaries, quoted prompts, documentation examples, or Codex-to-ChatGPT follow-ups.",
    ),
  );
  assert.ok(
    agents.includes(
      "Any handoff prompt must reflect the updated repository state after your own actions are complete and must contain only remaining work.",
    ),
  );
  assert.ok(agents.includes("Exclude already-completed work and anything ChatGPT could still perform directly."));

  assert.ok(readme.includes("## QC / Collaboration"));
  assert.ok(
    readme.includes("Shared QC authority: `../Shared Repo Resources/docs/jobapp/*` and the corresponding shared scripts in `../Shared Repo Resources/scripts/`"),
  );
  assert.ok(readme.includes("Shared Codex handoff contract: `../Shared Repo Resources/docs/jobapp/codex-model-handoff-contract.md`"));
  assert.ok(readme.includes("Local validation gates: `pnpm test`, `pnpm build`, `pnpm tsgo`, and `pnpm check`"));
  assert.ok(readme.includes("Release/closeout guidance: [docs/reference/RELEASING.md](./docs/reference/RELEASING.md)"));
  assert.ok(
    readme.includes("If a covered openclaw response newly issues a live ChatGPT-to-Codex execution handoff, the final non-empty line must be the exact shared `Model for Codex:` line; otherwise that line must be absent."),
  );
  assert.equal(packageJson.scripts["test:qc-alignment"], "node --test test/qc-alignment.test.mjs");
  assert.equal(packageJson.scripts["test:qc-handoff"], "node --test test/codex-handoff-contract.test.mjs");
});
