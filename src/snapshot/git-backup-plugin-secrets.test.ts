import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireGitCommand } from "../infra/git-exec.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { restoreGitBackupDirectory } from "./git-backup-codec.js";
import { createGitBackupRowTransform } from "./git-backup-sanitizer.js";
import { createGitBackup } from "./git-backup.js";
import {
  createStateDatabaseFixture,
  expectDatabaseRows,
  gitBackupRepository,
  withBackupStateEnv,
} from "./git-backup.test-support.js";
import { withDatabase } from "./local-repository.test-support.js";

const roots = createTempDirTracker();
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  roots.cleanup();
});

it.each([true, false])(
  "redacts plugin credentials before push and preserves nonsecret state (exclude=%s)",
  async (excludeSecrets) => {
    const root = roots.make("git-backup-plugin-secrets-");
    const { stateDir, database } = createStateDatabaseFixture(root);
    const repository = gitBackupRepository(root);
    const credentials = [
      ["discord", "activities-sessions", "synthetic-discord-session-token"],
      ["discord", "activities-doc-tokens", "synthetic-discord-document-token"],
      ["google-meet", "oauth-credential", "current"],
      ["matrix", "credentials", "account:default"],
      ["matrix", "recovery-key", "current"],
      ["matrix", "idb-snapshot", "generation:chunk:0"],
      ["mcp-events", "subscriptions-v1", "subscription"],
      ["mcp-relay", "mcp-relay-authority", "identity"],
      ["msteams", "delegated-token", "current"],
      ["msteams", `sso-tokens-${"a".repeat(64)}`, "v2:user"],
      ["msteams", `delegated-token-${"b".repeat(64)}`, "current"],
      ["msteams", "sso-tokens", "v2:user"],
      ["reef", "identity", "keys"],
      ["reef", "registration", "setup-session"],
      ["twitch", "oauth-default", "current"],
      ["x", "x.oauth", "account:default"],
      ["zalo", "hosted-outbound-media", "media"],
      ["sms", `hosted-outbound-media-${"a".repeat(16)}`, "media"],
      ["synology-chat", `hosted-outbound-media-${"b".repeat(16)}`, "media"],
      ["zalouser", "credentials", "default"],
      ["zalouser", "@retained.credentials", "default"],
    ] as const;
    const nonsecrets = [
      ["x", "x.allowlist", "default:alice", "authorized-user"],
      ["x", "x.spend", "default:cycle", 15_000_000],
      ["active-memory", "session-toggles", "session", { disabled: true }],
      ["mcp-relay", "mcp-relay-authority", "grant:client", { clientId: "client" }],
      ["reef", "registration", "registered", { identity: "public-identity" }],
      ["sms", `hosted-outbound-media-chunks-${"a".repeat(16)}`, "chunk", "media-chunk"],
      ["fixture", "@retained.history", "message", "durable-history"],
      ["fixture", "credentials", "value", "unrelated-plugin-namespace"],
      ["discord", "activities-widgets", "widget", { html: "widget-content" }],
      ["discord", "activities-launches", "launch", { widgetId: "widget" }],
    ] as const;
    const markers = credentials.map((_, index) => `synthetic-plugin-secret-${index}`);
    const blobSecret = "synthetic-plugin-blob-secret";
    const publicBlob = "public-custom-plugin-data";
    withDatabase(database.path, (db) => {
      const insert = db.prepare(
        "INSERT INTO plugin_state_entries (plugin_id, namespace, entry_key, value_json, created_at) VALUES (?, ?, ?, ?, 1)",
      );
      credentials.forEach(([plugin, namespace, key], index) =>
        insert.run(plugin, namespace, key, JSON.stringify({ credential: markers[index] })),
      );
      nonsecrets.forEach(([plugin, namespace, key, value]) =>
        insert.run(plugin, namespace, key, JSON.stringify(value)),
      );
      for (const namespace of ["thread-bindings", "@retained.thread-bindings"]) {
        insert.run(
          "discord",
          namespace,
          "thread",
          JSON.stringify({
            threadId: "thread",
            agentId: "main",
            webhookToken: "synthetic-webhook-token",
          }),
        );
      }
      const insertBlob = db.prepare(
        "INSERT INTO plugin_blob_entries (plugin_id, namespace, entry_key, metadata_json, blob, created_at) VALUES (?, ?, ?, '{}', ?, 1)",
      );
      insertBlob.run("zalouser", "credentials", "blob", Buffer.from(blobSecret));
      insertBlob.run("fixture", "documents", "document", Buffer.from("durable-document"));
      insertBlob.run("fixture", "credentials", "public-metadata", Buffer.from(publicBlob));
    });

    const remote = path.join(root, "remote.git");
    await requireGitCommand(root, ["init", "--bare", remote]);
    await repository.init(remote);
    const result = await withBackupStateEnv({ OPENCLAW_STATE_DIR: stateDir }, () =>
      createGitBackup({ ...repository.options, databases: [database], excludeSecrets, push: true }),
    );
    expect(result.pushed).toBe(true);
    const remoteFile = (file: string) =>
      requireGitCommand(remote, ["show", `${result.commit}:global/${file}`]);
    const stateRows = await remoteFile("tables/plugin_state_entries.jsonl");
    const blobRows = await remoteFile("tables/plugin_blob_entries.jsonl");
    for (const marker of markers) {
      expect.soft(stateRows.includes(marker), marker).toBe(!excludeSecrets);
    }
    expect.soft(stateRows.includes("synthetic-discord-session-token")).toBe(!excludeSecrets);
    expect.soft(stateRows.includes("synthetic-discord-document-token")).toBe(!excludeSecrets);
    expect.soft(stateRows.includes("synthetic-webhook-token")).toBe(!excludeSecrets);
    expect(blobRows.includes(Buffer.from(blobSecret).toString("hex"))).toBe(!excludeSecrets);
    expect(blobRows).toContain(Buffer.from("durable-document").toString("hex"));
    expect(blobRows).toContain(Buffer.from(publicBlob).toString("hex"));
    for (const [plugin, namespace, key, value] of nonsecrets) {
      expect(stateRows).toContain(
        JSON.stringify({
          plugin_id: plugin,
          namespace,
          entry_key: key,
          value_json: JSON.stringify(value),
          created_at: 1,
          expires_at: null,
        }),
      );
    }

    const restored = path.join(root, "restored.sqlite");
    await restoreGitBackupDirectory({
      sourcePath: repository.file("global"),
      targetPath: restored,
      expectedIdentity: { role: "global" },
    });
    expectDatabaseRows(restored, {
      "SELECT value_json FROM plugin_state_entries WHERE plugin_id = 'discord' AND namespace IN ('thread-bindings', '@retained.thread-bindings')":
        ["thread-bindings", "@retained.thread-bindings"].map(() => ({
          value_json: JSON.stringify(
            excludeSecrets
              ? { threadId: "thread", agentId: "main" }
              : { threadId: "thread", agentId: "main", webhookToken: "synthetic-webhook-token" },
          ),
        })),
      "SELECT value_json FROM plugin_state_entries WHERE plugin_id = 'x' AND namespace = 'x.spend'":
        [{ value_json: "15000000" }],
      "SELECT value_json FROM plugin_state_entries WHERE plugin_id = 'active-memory'": [
        { value_json: '{"disabled":true}' },
      ],
      "SELECT namespace, hex(blob) AS bytes FROM plugin_blob_entries WHERE plugin_id = 'fixture' ORDER BY namespace":
        [
          {
            namespace: "credentials",
            bytes: Buffer.from(publicBlob).toString("hex").toUpperCase(),
          },
          {
            namespace: "documents",
            bytes: Buffer.from("durable-document").toString("hex").toUpperCase(),
          },
        ],
    });
  },
);

it("filters plugin credentials before PostgreSQL image materialization with a generic Git identity", () => {
  const transform = createGitBackupRowTransform(
    { role: "generic" },
    "state",
    new Set(["plugin_state_entries", "plugin_blob_entries"]),
  );
  const secret = { plugin_id: "matrix", namespace: "credentials", entry_key: "account:default" };
  for (const table of ["plugin_state_entries", "plugin_blob_entries"]) {
    expect(transform(table, secret)).toBeUndefined();
    const durable = { plugin_id: "x", namespace: "x.spend", entry_key: "cycle", value_json: "15" };
    expect(transform(table, durable)).toEqual(durable);
  }
  const binding = { plugin_id: "discord", namespace: "thread-bindings", entry_key: "thread" };
  expect(
    transform("plugin_state_entries", {
      ...binding,
      value_json: '{"threadId":"thread","webhookToken":"synthetic-webhook-token"}',
    }),
  ).toEqual({ ...binding, value_json: '{"threadId":"thread"}' });
  for (const value_json of ['{"webhookToken":', '"synthetic-webhook-token"', "[]"]) {
    expect(transform("plugin_state_entries", { ...binding, value_json })).toBeUndefined();
  }
});
