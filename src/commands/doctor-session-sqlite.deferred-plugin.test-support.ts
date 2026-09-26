import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
} from "../infra/deferred-plugin-migrations.js";
import { recordLegacyMigrationRun } from "../infra/state-migrations.receipts.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";

/** Inject competing work inside synchronous publication callbacks. */
export function seedConcurrentDeferredPluginMigration(state: OpenClawTestState, pluginId: string) {
  const previous = readDeferredPluginMigrations({ env: state.env }).find(
    (pending) => pending.pluginId === pluginId,
  );
  runOpenClawStateWriteTransaction(
    ({ db }) =>
      recordLegacyMigrationRun(db, {
        runId: `deferred-plugin-migration:${pluginId}`,
        startedAt: 1,
        finishedAt: null,
        status: "pending",
        reportJson: JSON.stringify({
          ...previous,
          pluginId,
          reason: "A concurrent Doctor found additional migration work.",
          command: "openclaw doctor --fix",
          requiresStateMigration: true,
        }),
        upsert: true,
      }),
    { env: state.env },
  );
}

export async function seedDeferredPluginSessionSource(
  state: OpenClawTestState,
  layout: "external" | "default" | "legacy-root" = "external",
  pluginId = "fixture-plugin",
  missingTranscript?: "declared" | "metadata-only",
) {
  // This fixture models active legacy stores with known deletion history.
  openOpenClawStateDatabase({ env: state.env });
  const sessionsDir =
    layout === "external"
      ? path.join(state.root, "external-sessions")
      : layout === "default"
        ? state.sessionsDir("main")
        : state.statePath("sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const storePath = path.join(sessionsDir, "sessions.json");
  const records = Object.fromEntries(
    ["kept", "deleted", ...(missingTranscript ? ["missing"] : [])].map((name) => {
      const sessionId = `legacy-${name}`;
      const transcript = path.join(sessionsDir, `${sessionId}.jsonl`);
      if (name === "missing") {
        return [
          `agent:main:${name}`,
          {
            sessionId,
            ...(missingTranscript === "declared" ? { sessionFile: path.basename(transcript) } : {}),
            updatedAt: 20,
          },
        ];
      }
      fs.writeFileSync(
        transcript,
        [
          { type: "session", version: 3, id: sessionId },
          {
            type: "message",
            id: `${name}-message`,
            parentId: null,
            message: { role: "user", content: name },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      fs.writeFileSync(
        `${transcript}.${pluginId === "codex" ? "codex-app-server" : pluginId}.json`,
        JSON.stringify({
          schemaVersion: 2,
          threadId: name,
          sessionFile: transcript,
          updatedAt: "2026-01-01T00:00:00.000Z",
          pluginAppPolicyContext: { fingerprint: "policy-1", apps: {}, pluginAppIds: {} },
        }),
      );
      return [
        `agent:main:${name}`,
        { sessionId, sessionFile: path.basename(transcript), updatedAt: 20 },
      ];
    }),
  );
  fs.writeFileSync(storePath, JSON.stringify(records));
  const cfg: OpenClawConfig = {
    agents: { entries: { main: { default: true } } },
    ...(layout === "external" ? { session: { store: storePath } } : {}),
  };
  await recordDeferredPluginMigrations({
    env: state.env,
    pending: [
      {
        pluginId,
        reason: "The configured plugin is not installed.",
        command:
          pluginId === "codex"
            ? "openclaw plugins install @openclaw/codex"
            : "openclaw plugins install @example/fixture-plugin",
        ...(layout === "external" ? { configPaths: [["session", "store"]] } : {}),
      },
    ],
  });
  const originals = new Map(
    fs.readdirSync(sessionsDir).map((name) => {
      const file = path.join(sessionsDir, name);
      return [file, fs.readFileSync(file)];
    }),
  );
  const scope = {
    agentId: "main",
    env: state.env,
    storePath:
      layout === "legacy-root" ? path.join(state.sessionsDir("main"), "sessions.json") : storePath,
  };
  return { cfg, storePath, originals, scope };
}
