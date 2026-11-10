import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const frozenTargetEntrypoint = "scripts/preflight-frozen-target-contracts.mjs";
const survivorDirectory = "scripts/e2e/lib/upgrade-survivor";

/** The cold admission closure, without installing or executing selected-source dependencies. */
export function copyFrozenTargetTooling(root: string, extra: string[] = []) {
  const files = [
    frozenTargetEntrypoint,
    "scripts/lib/frozen-target-workflow-request.mjs",
    "scripts/lib/release-upgrade-baseline.mjs",
    "scripts/lib/canonical-json.mjs",
    "scripts/lib/docker-e2e-plan.mts",
    "scripts/lib/docker-e2e-scenarios.mts",
    "scripts/lib/official-external-channel-catalog.json",
    "scripts/lib/official-external-provider-catalog.json",
    "scripts/lib/record-shared.mjs",
    "scripts/lib/update-compat-inventory.json",
    "scripts/lib/update-first-hop-lanes.mjs",
    "scripts/lib/upgrade-survivor-policy.mjs",
    "scripts/lib/upgrade-survivor-scenarios.json",
    "scripts/lib/release-version.mjs",
    "scripts/lib/frozen-target-source.mjs",
    "scripts/lib/frozen-target-compat.sh",
    "scripts/lib/trusted-native-typescript.mjs",
    "scripts/lib/native-typescript.mts",
    "scripts/resolve-frozen-codex-live-suite.mjs",
    "scripts/resolve-fs-safe-native-contract.mjs",
    `${survivorDirectory}/config-recipe.mts`,
    `${survivorDirectory}/config-recipe`,
    `${survivorDirectory}/installed-recovery-cases.mjs`,
    "scripts/windows-cmd-helpers.mjs",
    "package.json",
    "pnpm-lock.yaml",
    ...extra,
  ];
  for (const file of files) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(file, target, { recursive: true });
  }
}

export function fixtureGit(root: string, ...args: string[]) {
  const settings = [
    "core.hooksPath=/dev/null",
    "commit.gpgsign=false",
    "user.name=Fixture",
    "user.email=fixture@example.test",
  ];
  return execFileSync("git", [...settings.flatMap((setting) => ["-c", setting]), ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function commitFixture(root: string, excluded: string[] = []) {
  const git = (...args: string[]) => fixtureGit(root, ...args);
  git("init", "-q");
  git("add", "--", ".", ...excluded.map((file) => `:(exclude)${file}`));
  git("commit", "-qm", "fixture");
  return { root, sha: git("rev-parse", "HEAD"), git };
}
