import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getGlobalHookRunner, resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  loadDeliveryQueueEntry,
  seedDeliveryQueueEntry,
} from "./delivery-queue-sqlite.test-support.js";
import type { LegacyQueuedDelivery, QueuedDelivery } from "./outbound/delivery-queue-types.js";
import { createUnmodifiedPreparedOutboundBatch } from "./outbound/prepared-batch.js";
import { autoMigrateLegacyState } from "./state-migrations.doctor.js";

const pluginId = "doctor-outbound-fixture";
let state: OpenClawTestState;
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
  state = await createOpenClawTestState({
    label: "doctor-outbound",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  const pluginDir = state.path("plugin");
  pluginFile = path.join(pluginDir, "index.cjs");
  eventsFile = state.path("events.txt");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({ id: pluginId, channels: ["matrix"], configSchema: { type: "object" } }),
  );
  await writePluginFixture();
  cfg = {
    plugins: {
      allow: [pluginId],
      load: { paths: [pluginFile] },
      entries: { [pluginId]: { enabled: true } },
      slots: { memory: "none" },
    },
    channels: { matrix: { enabled: true } },
  };
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  resetGlobalHookRunner();
});

afterEach(async () => {
  resetPluginLoaderTestStateForTest();
  resetGlobalHookRunner();
  await state.cleanup();
});

function repair(doctorOnlyStateMigrations = true) {
  return autoMigrateLegacyState({
    cfg,
    env: process.env,
    doctorOnlyStateMigrations,
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
  });
}

function seed(queueName: string, prepared = false) {
  const route = { channel: "matrix", to: "!synthetic:example" };
  const counters = { retryCount: 0, attemptCount: 0 };
  const common = { id: "fixture", enqueuedAt: Date.now(), ...counters, ...route };
  const entry: QueuedDelivery | LegacyQueuedDelivery = prepared
    ? {
        ...common,
        preparedBatch: createUnmodifiedPreparedOutboundBatch([{ text: "already prepared" }]),
      }
    : {
        ...common,
        payloads: [{ text: "original" }],
        replyPayloadSendingHook: { kind: "final", context: { channelId: "matrix" } },
      };
  seedDeliveryQueueEntry({
    queueName,
    stateDir: state.stateDir,
    entry: {
      ...entry,
      ...(queueName === "outbound-legacy-preparing-v1"
        ? { legacyPreparationState: "claimed" }
        : {}),
    },
  });
  return entry;
}
const load = (queue: string, id: string) => loadDeliveryQueueEntry(queue, id, state.stateDir);
const deliveryReceipt = (result: Awaited<ReturnType<typeof repair>>) =>
  result.stepReceipts.find((receipt) => receipt.id === "delivery-queues");
const expectEvents = async () =>
  expect(await fs.readFile(eventsFile, "utf8")).toBe("reply\nmessage\ndispose\n");

it.each(["sqlite", "claimed", "disposal-failure"] as const)(
  "handles %s preparation with real plugin modifiers",
  async (kind) => {
    if (kind === "disposal-failure") {
      await writePluginFixture({ failDisposal: true });
    }
    const entry = seed(kind === "claimed" ? "outbound-legacy-preparing-v1" : "outbound");
    await repair(false);
    const active = getActivePluginRegistry();
    expect(getGlobalHookRunner()).toBeNull();
    const result = await repair();
    await expectEvents();
    if (kind === "disposal-failure") {
      expect(deliveryReceipt(result)).toMatchObject({
        outcome: "refused",
        refusal: { code: "step-threw" },
      });
      return;
    }
    expect(result.warnings).toEqual([]);
    expect(deliveryReceipt(result)).toMatchObject({ outcome: "completed" });
    expect(load("outbound-prepared-v1", entry.id)).toMatchObject({
      preparedBatch: { entries: [{ payload: { text: "original|reply|message" } }] },
    });
    expect(getActivePluginRegistry()).toBe(active);
    expect(getGlobalHookRunner()).toBeNull();
    await repair();
    await expectEvents();
  },
);

it.each([false, true])("handles an unavailable plugin (already prepared: %s)", async (prepared) => {
  const entry = seed(prepared ? "outbound-prepared-migration-v1" : "outbound", prepared);
  await fs.writeFile(pluginFile, 'throw new Error("synthetic plugin unavailable");');
  const result = await repair();
  if (prepared) {
    expect(result.warnings).toEqual([]);
    expect(load("outbound-prepared-v1", entry.id)).toMatchObject({
      preparedBatch: { entries: [{ payload: { text: "already prepared" } }] },
    });
    await expect(fs.stat(eventsFile)).rejects.toMatchObject({ code: "ENOENT" });
  } else {
    expect(result.warnings.join("\n")).toContain("synthetic plugin unavailable");
    expect(load("outbound", entry.id)).toEqual(entry);
    expect(load("outbound-legacy-preparing-v1", entry.id)).toBeNull();
  }
});
