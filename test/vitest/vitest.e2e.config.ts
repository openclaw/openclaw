import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";
import { BUNDLED_PLUGIN_E2E_TEST_GLOB } from "./vitest.bundled-plugin-paths.ts";
import baseConfig from "./vitest.config.ts";
import { resolveRepoRootPath } from "./vitest.shared.config.ts";

// Auto-load `.env.local` from repo root so operators do not have to remember
// to `set -a; source .env.local; set +a` before every `pnpm test:e2e:discord`
// invocation. Only fill keys that are not already present in `process.env`
// so that explicit shell exports still win. We do this at vitest config load
// time (runs in the vitest driver process) so spawned workers inherit the
// vars.
//
// Does nothing if the file is absent — the repo never ships `.env.local`.
function loadRepoRootEnvLocalIfPresent(): void {
  try {
    const repoRoot = path.resolve(import.meta.dirname ?? "", "../..");
    const envLocalPath = path.join(repoRoot, ".env.local");
    const raw = fs.readFileSync(envLocalPath, "utf8");
    for (const line of raw.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
      if (!match) {
        continue;
      }
      const key = match[1];
      let value = match[2];
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined || process.env[key] === "") {
        process.env[key] = value;
      }
    }
  } catch {
    // File missing or unreadable — no-op. Operators who don't use .env.local
    // just pass the vars through the shell as before.
  }
}
loadRepoRootEnvLocalIfPresent();

const base = baseConfig as unknown as Record<string, unknown>;
const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const cpuCount = os.cpus().length;
// Keep e2e runs cheap by default; callers can still override via OPENCLAW_E2E_WORKERS.
const defaultWorkers = isCI ? Math.min(2, Math.max(1, Math.floor(cpuCount * 0.25))) : 1;
const requestedWorkers = Number.parseInt(process.env.OPENCLAW_E2E_WORKERS ?? "", 10);
const e2eWorkers =
  Number.isFinite(requestedWorkers) && requestedWorkers > 0
    ? Math.min(16, requestedWorkers)
    : defaultWorkers;
const verboseE2E = process.env.OPENCLAW_E2E_VERBOSE === "1";
// Discord's per-bot WebSocket gateway allows exactly ONE connection per bot
// token. The matrix block uses `describe.concurrent`, which inside a single
// worker would spin up multiple mini-gateways and hit 429/identify-storm
// behavior. Serialize concurrent describe.concurrent suites within a single
// worker so there is never more than one live Discord gateway at a time.
const e2eMaxConcurrency = 1;

const baseTestWithProjects =
  (baseConfig as { test?: { exclude?: string[]; projects?: string[]; setupFiles?: string[] } })
    .test ?? {};
const { projects: _projects, ...baseTest } = baseTestWithProjects as {
  exclude?: string[];
  projects?: string[];
  setupFiles?: string[];
};
const exclude = (baseTest.exclude ?? []).filter((p) => p !== "**/*.e2e.test.ts");

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    maxWorkers: e2eWorkers,
    maxConcurrency: e2eMaxConcurrency,
    silent: !verboseE2E,
    setupFiles: [
      ...new Set(
        [...(baseTest.setupFiles ?? []), "test/setup-openclaw-runtime.ts"].map(resolveRepoRootPath),
      ),
    ],
    include: [
      "test/**/*.e2e.test.ts",
      "src/**/*.e2e.test.ts",
      "src/gateway/gateway.test.ts",
      "src/gateway/server.startup-matrix-migration.integration.test.ts",
      "src/gateway/sessions-history-http.test.ts",
      BUNDLED_PLUGIN_E2E_TEST_GLOB,
    ],
    exclude,
  },
});
