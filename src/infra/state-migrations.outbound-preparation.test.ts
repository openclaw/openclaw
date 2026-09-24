import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getGlobalHookRunner, resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { loadDeliveryQueueEntry } from "./delivery-queue-sqlite.js";
import { seedDeliveryQueueEntry } from "./delivery-queue-sqlite.test-support.js";
import type { LegacyQueuedDelivery, QueuedDelivery } from "./outbound/delivery-queue-types.js";
import { createUnmodifiedPreparedOutboundBatch } from "./outbound/prepared-batch.js";
import { autoMigrateLegacyState } from "./state-migrations.doctor.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string;
let pluginFile: string;
let eventsFile: string;
let cfg: OpenClawConfig;

async function writePluginFixture({ failDisposal = false }: { failDisposal?: boolean } = {}) {
  await fs.writeFile(
    pluginFile,
    `module.exports = {
    id: "doctor-outbound-fixture",
    register(api) {
      const record = (value) => require("node:fs").appendFileSync(${JSON.stringify(eventsFile)}, value + "\\n");
      api.on("reply_payload_sending", (event) => {
        record("reply");
        return { payload: { ...event.payload, text: event.payload.text + "|reply" } };
      });
      api.on("message_sending", (event) => {
        if (api.runtime.config.current().plugins.entries["doctor-outbound-fixture"].enabled !== true) {
          throw new Error("migration modifier lost its configured runtime");
        }
        record("message");
        return { content: event.content + "|message" };
      });
      api.lifecycle.onDispose(async () => {
        await require("node:fs/promises").appendFile(${JSON.stringify(eventsFile)}, "dispose\\n");
      });
      ${failDisposal ? 'api.registerRuntimeLifecycle({ id: "receipt-failure", dispose() { throw new Error("synthetic outbound disposal failure"); } });' : ""}
      api.registerChannel({ plugin: {
        id: "matrix", meta: { id: "matrix", label: "Fixture", selectionLabel: "Fixture", docsPath: "/fixture", blurb: "Synthetic" },
        capabilities: { chatTypes: ["direct"] },
        config: { listAccountIds: () => ["default"], resolveAccount: () => ({}) },
        outbound: { deliveryMode: "direct", sendText: async () => { throw new Error("migration must not send"); } },
      } });
    },
  };`,
  );
}

beforeEach(async () => {
  const home = temporary.make("openclaw-doctor-outbound-");
  stateDir = path.join(home, ".openclaw");
  const pluginDir = path.join(home, "plugin");
  pluginFile = path.join(pluginDir, "index.cjs");
  eventsFile = path.join(home, "events.txt");
  vi.stubEnv("HOME", home);
  vi.stubEnv("OPENCLAW_HOME", home);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "doctor-outbound-fixture",
      channels: ["matrix"],
      configSchema: { type: "object" },
    }),
  );
  await writePluginFixture();
  cfg = {
    plugins: {
      allow: ["doctor-outbound-fixture"],
      load: { paths: [pluginFile] },
      entries: { "doctor-outbound-fixture": { enabled: true } },
      slots: { memory: "none" },
    },
    channels: { matrix: { enabled: true } },
  };
  await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(cfg));
  resetGlobalHookRunner();
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  resetPluginLoaderTestStateForTest();
  resetGlobalHookRunner();
  vi.unstubAllEnvs();
});

function repair() {
  return autoMigrateLegacyState({
    cfg,
    env: process.env,
    doctorOnlyStateMigrations: true,
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
  });
}

function legacy(id: string): LegacyQueuedDelivery {
  return {
    id,
    enqueuedAt: Date.now(),
    retryCount: 0,
    attemptCount: 0,
    channel: "matrix",
    to: "!synthetic:example",
    payloads: [{ text: "original" }],
    replyPayloadSendingHook: { kind: "final", context: { channelId: "matrix" } },
  };
}

describe("Doctor outbound preparation", () => {
  it.each(["file", "sqlite", "claimed"] as const)(
    "prepares %s custody with real plugin modifiers once without publishing a registry",
    async (kind) => {
      const source = path.join(stateDir, "delivery-queue", "from-file.json");
      await fs.mkdir(path.dirname(source), { recursive: true });
      const bytes = JSON.stringify(legacy("from-file"));
      if (kind === "file") {
        await fs.writeFile(source, bytes);
      } else {
        seedDeliveryQueueEntry({
          stateDir,
          queueName: kind === "sqlite" ? "outbound" : "outbound-legacy-preparing-v1",
          entry: {
            ...legacy("from-file"),
            ...(kind === "claimed" ? { legacyPreparationState: "claimed" } : {}),
          },
        });
      }
      await autoMigrateLegacyState({
        cfg,
        env: process.env,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
      if (kind === "file") {
        expect(await fs.readFile(source, "utf8")).toBe(bytes);
      }
      const active = getActivePluginRegistry();
      expect(getGlobalHookRunner()).toBeNull();
      const result = await repair();
      expect(result.warnings).toEqual([]);
      expect(result.stepReceipts.find((receipt) => receipt.id === "delivery-queues")).toMatchObject(
        {
          outcome: "completed",
        },
      );
      expect(loadDeliveryQueueEntry("outbound-prepared-v1", "from-file", stateDir)).toMatchObject({
        preparedBatch: { entries: [{ payload: { text: "original|reply|message" } }] },
      });
      expect(await fs.readFile(eventsFile, "utf8")).toBe("reply\nmessage\ndispose\n");
      expect(getActivePluginRegistry()).toBe(active);
      expect(getGlobalHookRunner()).toBeNull();
      await repair();
      expect(await fs.readFile(eventsFile, "utf8")).toBe("reply\nmessage\ndispose\n");
    },
  );

  it("records a refused delivery migration when its resource disposer fails", async () => {
    await writePluginFixture({ failDisposal: true });
    seedDeliveryQueueEntry({ queueName: "outbound", entry: legacy("disposal-failure"), stateDir });

    const result = await repair();

    expect(result.stepReceipts.find((receipt) => receipt.id === "delivery-queues")).toMatchObject({
      outcome: "refused",
      refusal: { code: "step-threw" },
    });
    expect(await fs.readFile(eventsFile, "utf8")).toBe("reply\nmessage\ndispose\n");
  });

  it("preserves an unclaimed SQLite legacy row when its plugin cannot load", async () => {
    const entry = legacy("sqlite-only");
    seedDeliveryQueueEntry({ queueName: "outbound", entry, stateDir });
    await fs.writeFile(pluginFile, 'throw new Error("synthetic plugin unavailable");');
    const result = await repair();
    expect(result.warnings.join("\n")).toContain("synthetic plugin unavailable");
    expect(loadDeliveryQueueEntry("outbound", entry.id, stateDir)).toEqual(entry);
    expect(loadDeliveryQueueEntry("outbound-legacy-preparing-v1", entry.id, stateDir)).toBeNull();
  });

  it("finishes prepared checkpoints without loading an unavailable plugin", async () => {
    const entry: QueuedDelivery = {
      id: "checkpoint",
      enqueuedAt: Date.now(),
      retryCount: 0,
      attemptCount: 0,
      channel: "matrix",
      to: "!synthetic:example",
      preparedBatch: createUnmodifiedPreparedOutboundBatch([{ text: "already prepared" }]),
    };
    seedDeliveryQueueEntry({
      queueName: "outbound-prepared-migration-v1",
      stateDir,
      entry,
    });
    await fs.writeFile(pluginFile, 'throw new Error("synthetic plugin unavailable");');
    const result = await repair();
    expect(result.warnings).toEqual([]);
    expect(loadDeliveryQueueEntry("outbound-prepared-v1", "checkpoint", stateDir)).toMatchObject({
      preparedBatch: { entries: [{ payload: { text: "already prepared" } }] },
    });
    await expect(fs.stat(eventsFile)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
