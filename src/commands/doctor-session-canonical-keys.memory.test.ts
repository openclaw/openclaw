import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import { afterAll, beforeAll, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import { createSqliteSchemaAssetsPlugin } from "../../scripts/lib/sqlite-schema-assets.mts";
import { createStateSchemaInlinePlugin } from "../../scripts/lib/state-schema-inline-plugin.mts";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { canonicalMemoryTestSupportModuleUrl } from "./doctor-session-canonical-keys.memory.test-support.js";
import { insertLegacySession } from "./doctor-session-canonical-keys.test-support.js";
import { runDoctorChild } from "./doctor-session-child.test-support.js";

const ROW_COUNT = 48;
const ENTRY_PAYLOAD_BYTES = 512 * 1024;
const CHILD_HEAP_MIB = 160;
let bundleDir: string | undefined;
let childPath: string;

beforeAll(async () => {
  fs.mkdirSync(path.join(process.cwd(), "node_modules/.cache"), { recursive: true });
  bundleDir = fs.mkdtempSync(path.join(process.cwd(), "node_modules/.cache/canonical-memory-"));
  childPath = path.join(bundleDir, "child.mjs");
  const { bundles } = await build({
    config: false,
    dts: false,
    entry: { child: fileURLToPath(canonicalMemoryTestSupportModuleUrl) },
    format: "esm",
    // Keep generated source overhead out of the entry-data heap budget;
    // preserve function/class names used by runtime dispatch and diagnostics.
    minify: { codegen: true, compress: true, mangle: { keepNames: true } },
    outDir: bundleDir,
    outExtensions: () => ({ js: ".mjs" }),
    // Preserve lazy runtime imports so unused provider SDKs do not consume the child heap.
    outputOptions: { codeSplitting: true },
    deps: {
      alwaysBundle: (id) =>
        Object.entries(packageJson.dependencies).some(
          ([name, version]) =>
            version.startsWith("workspace:") && (id === name || id.startsWith(`${name}/`)),
        ),
      neverBundle: Object.entries(packageJson.dependencies)
        .filter(([, version]) => !version.startsWith("workspace:"))
        .map(([name]) => name),
    },
    plugins: [createStateSchemaInlinePlugin(), createSqliteSchemaAssetsPlugin()],
    platform: "node",
    target: "node22",
    logLevel: "error",
  });
  for (const bundle of bundles) {
    await bundle[Symbol.asyncDispose]();
  }
});

afterAll(() => {
  if (bundleDir) {
    fs.rmSync(bundleDir, { force: true, recursive: true });
  }
});

function payloadFor(index: number): string {
  const prefix = `recovered prompt snapshot ${index}:`;
  return `${prefix}${"x".repeat(ENTRY_PAYLOAD_BYTES - prefix.length)}`;
}

const sessionKeyFor = (index: number) =>
  index === 0
    ? "agent:main:main"
    : `agent:main:dashboard:memory-${index.toString().padStart(4, "0")}`;

it("keeps canonical SQLite entry JSON streaming under a low child heap", async () => {
  await withOpenClawTestState({ applyEnv: false, layout: "state-only" }, async (state) => {
    const scope = { agentId: "main", env: state.env };
    const storeTemplate = state.statePath("agents", "{agentId}", "sessions", "sessions.json");
    const storePath = resolveSessionStorePathCore(storeTemplate, scope);
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const databaseOptions = {
      ...scope,
      path: resolveSqliteTargetFromSessionStorePath(storePath, scope).path,
    };
    openOpenClawAgentDatabase(databaseOptions);
    const runChild = () =>
      runDoctorChild(
        [`--max-old-space-size=${CHILD_HEAP_MIB}`, childPath, state.stateDir, storeTemplate],
        state.env,
      );

    closeOpenClawAgentDatabasesForTest();
    await expect(runChild()).resolves.toMatchObject({ foundGroups: 0, scannedStores: 1 });
    const writable = openOpenClawAgentDatabase(databaseOptions);
    const updateWindow = writable.db.prepare(
      `UPDATE session_windows
          SET chat_type = 'direct', model_provider = 'openai', model = 'gpt-5.5',
              agent_harness_id = 'codex'
        WHERE session_id = ?`,
    );
    runSqliteImmediateTransactionSync(writable.db, () => {
      for (let index = 0; index < ROW_COUNT; index += 1) {
        const sessionId = `memory-session-${index.toString().padStart(4, "0")}`;
        const updatedAt = 1_800_000_000_000 + index;
        insertLegacySession({
          ...scope,
          entry: {
            sessionId,
            skillsSnapshot: { prompt: payloadFor(index), skills: [] },
            updatedAt,
          },
          sessionKey: sessionKeyFor(index),
          storePath,
        });
        updateWindow.run(sessionId);
      }
      writable.db.prepare("UPDATE session_nodes SET entry_valid = 1").run();
    });
    closeOpenClawAgentDatabasesForTest();

    await expect(runChild()).resolves.toMatchObject({ foundGroups: 0, scannedStores: 1 });
    const { db } = openOpenClawAgentDatabase(databaseOptions);
    const counts = db
      .prepare(
        "SELECT (SELECT count(*) FROM session_nodes) AS nodes, (SELECT count(*) FROM session_windows) AS windows, (SELECT count(*) FROM session_nodes WHERE entry_valid <> 1) AS invalid",
      )
      .get();
    expect(counts).toEqual({ nodes: ROW_COUNT, windows: ROW_COUNT, invalid: 0 });
    for (const index of [0, Math.floor(ROW_COUNT / 2), ROW_COUNT - 1]) {
      const row = db
        .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
        .get(sessionKeyFor(index)) as { entry_json: string };
      const prompt = (JSON.parse(row.entry_json) as { skillsSnapshot: { prompt: string } })
        .skillsSnapshot.prompt;
      expect(prompt).toBe(payloadFor(index));
    }
  });
}, 90_000);
