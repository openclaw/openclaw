import fs from "node:fs";
import path from "node:path";
import { StatementSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import * as deliveryInfo from "../../config/sessions/delivery-info.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as transcriptRuntime from "../../config/sessions/transcript.runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import { readVisibleSessionTranscriptMessageEntries } from "../../plugin-sdk/session-transcript-runtime.js";
import { readPluginNoticeData } from "../../shared/plugin-notice.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  loadOpenClawPlugins,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePluginMetadata,
} from "../loader.test-fixtures.js";
import * as nativeModule from "../native-module-require.js";
import { revokePluginRecord } from "../registry-lifecycle.js";
import * as sdkAlias from "../sdk-alias.js";
import { createPluginRuntime } from "./index.js";
import type { PluginRuntime } from "./types.js";

const PLUGIN_ID = "notice-proof";
// A real on-disk plugin: it registers its own channel and keeps the runtime its register(api) got.
const PLUGIN_SOURCE = `const sent = [];
const channel = {
  id: "${PLUGIN_ID}",
  meta: { id: "${PLUGIN_ID}", label: "Notice proof", selectionLabel: "Notice proof",
    docsPath: "/channels/${PLUGIN_ID}", blurb: "test channel" },
  capabilities: { chatTypes: ["direct"] },
  config: { listAccountIds: () => ["default"], resolveAccount: () => ({}) },
  outbound: {
    deliveryMode: "direct",
    presentationCapabilities: { supported: true, buttons: true },
    renderPresentation: ({ payload, presentation }) => ({ ...payload, channelData: { buttons: presentation } }),
    sendPayload: async (ctx) => {
      sent.push({ to: ctx.to, threadId: ctx.threadId, payload: ctx.payload });
      globalThis.noticeProofFixture.afterSend?.();
      return { channel: "${PLUGIN_ID}", messageId: "m" + sent.length };
    },
    sendText: async (ctx) => {
      sent.push({ to: ctx.to, payload: { text: ctx.text } });
      return { channel: "${PLUGIN_ID}", messageId: "m" + sent.length };
    },
  },
};
module.exports = { id: "${PLUGIN_ID}", register(api) {
  api.registerChannel({ plugin: channel });
  globalThis.noticeProofFixture = { runtime: api.runtime, sent };
} };`;

type Proof = {
  runtime: PluginRuntime;
  sent: Array<{ to: string; threadId?: string | number; payload: Record<string, unknown> }>;
  afterSend?: () => void;
};

let state: OpenClawTestState;
let pluginDir: string;
let proof: Proof;
let storePath: string;
let revoke: () => void;

beforeAll(async () => {
  useNoBundledPlugins();
  state = await createOpenClawTestState({ prefix: "openclaw-session-notice-" });
  pluginDir = makePluginLoaderTempDir();
  fs.writeFileSync(path.join(pluginDir, "index.cjs"), PLUGIN_SOURCE, "utf8");
  writePluginMetadata({
    dir: pluginDir,
    id: PLUGIN_ID,
    channels: [PLUGIN_ID],
    packageJson: { name: PLUGIN_ID, version: "1.0.0", openclaw: { extensions: ["./index.cjs"] } },
  });
  storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
});

// The shared test setup reinstalls the default registry after each test.
beforeEach(() => {
  // Production loads the host runtime natively into the same module graph as the Gateway.
  // Under Vitest a native require would load a second copy with its own config snapshot,
  // so hand the loader this graph's real runtime factory instead.
  const resolveRuntime = vi.spyOn(sdkAlias, "resolvePluginRuntimeModulePathWithDiagnostics");
  const nativeLoad = nativeModule.tryNativeRequireModule;
  vi.spyOn(nativeModule, "tryNativeRequireModule").mockImplementation((modulePath, options) =>
    modulePath === resolveRuntime.mock.results.at(-1)?.value?.resolvedPath
      ? { ok: true, moduleExport: { createPluginRuntime } }
      : nativeLoad(modulePath, options),
  );
  const config: OpenClawConfig = {
    agents: { entries: { main: { workspace: state.workspaceDir } } },
    plugins: { allow: [PLUGIN_ID], load: { paths: [pluginDir] } },
  };
  const registry = loadOpenClawPlugins({ config, onlyPluginIds: [PLUGIN_ID], cache: false });
  expect(registry.plugins.map(({ id, status }) => ({ id, status }))).toEqual([
    { id: PLUGIN_ID, status: "loaded" },
  ]);
  setRuntimeConfigSnapshot(config);
  const record = registry.plugins.find(({ id }) => id === PLUGIN_ID)!;
  // The registry's own revocation path, as used when a plugin instance is unloaded.
  revoke = () => revokePluginRecord(registry, record);
  proof = (globalThis as { noticeProofFixture?: Proof }).noticeProofFixture!;
  delete proof.afterSend;
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

afterAll(async () => {
  delete (globalThis as { noticeProofFixture?: Proof }).noticeProofFixture;
  resetPluginLoaderTestStateForTest();
  closeOpenClawAgentDatabasesForTest();
  await state.cleanup();
});

const presentation = {
  blocks: [
    {
      type: "buttons" as const,
      buttons: [{ label: "Undo", action: { type: "command" as const, command: "/proof undo 1" } }],
    },
  ],
};

async function seedSession(
  sessionKey: string,
  channel: string | undefined,
  lifecycleRevision = "r1",
  threadId?: string,
) {
  await upsertSessionEntryCore(
    { agentId: "main", storePath, sessionKey },
    {
      sessionId: `${sessionKey}-session`,
      lifecycleRevision,
      updatedAt: Date.now(),
      ...(channel
        ? {
            delivery: {
              kind: "external" as const,
              route: { channel, accountId: "default", target: { to: "user-1" } },
              context: {
                channel,
                accountId: "default",
                to: "user-1",
                ...(threadId ? { threadId } : {}),
              },
              origin: { provider: channel, accountId: "default", to: "user-1" },
            },
          }
        : {}),
    },
  );
}

async function notices(sessionKey: string) {
  const entries = await readVisibleSessionTranscriptMessageEntries({
    agentId: "main",
    storePath,
    sessionKey,
    sessionId: `${sessionKey}-session`,
  });
  return entries.flatMap((entry) => readPluginNoticeData(entry.message, PLUGIN_ID, "done") ?? []);
}

function post(
  generation: NonNullable<Awaited<ReturnType<typeof capture>>>,
  id: string,
  deliver: { skipChannels?: string[] } | undefined = {},
) {
  return proof.runtime.system.postSessionNotice({
    generation,
    notice: { type: "done", text: `Job ${id} finished.`, data: { id }, presentation },
    idempotencyKey: `${PLUGIN_ID}:${id}`,
    systemEvent: `Job ${id} context.`,
    ...(deliver ? { deliver } : {}),
  });
}

function capture(sessionKey: string) {
  return proof.runtime.system.captureSessionGeneration({ agentId: "main", sessionKey });
}

it("delivers to the session's plugin channel with buttons and records the plugin's notice", async () => {
  const sessionKey = `agent:main:${PLUGIN_ID}:direct:user-1`;
  await seedSession(sessionKey, PLUGIN_ID);
  const generation = await capture(sessionKey);
  expect(generation).toMatchObject({ sessionKey, sessionId: `${sessionKey}-session` });

  await expect(post(generation!, "a")).resolves.toEqual({ status: "posted", delivered: true });
  expect(proof.sent).toMatchObject([
    { to: "user-1", payload: { text: "Job a finished.", channelData: { buttons: presentation } } },
  ]);
  expect(await notices(sessionKey)).toEqual([{ id: "a" }]);
  expect(peekSystemEvents(sessionKey)).toEqual(["Job a context."]);
});

it("finishes the transcript on retry without sending the channel message again", async () => {
  const sessionKey = `agent:main:${PLUGIN_ID}:direct:user-5`;
  await seedSession(sessionKey, PLUGIN_ID);
  const generation = await capture(sessionKey);
  vi.spyOn(transcriptRuntime, "appendAssistantMessageToSessionTranscript").mockResolvedValueOnce({
    ok: false,
    reason: "injected transcript failure",
  });

  await expect(post(generation!, "f")).resolves.toEqual({
    status: "failed",
    stage: "transcript",
    error: "injected transcript failure",
  });
  await expect(post(generation!, "f")).resolves.toMatchObject({ status: "posted" });
  expect(proof.sent).toHaveLength(1);
  expect(await notices(sessionKey)).toEqual([{ id: "f" }]);
});

it("posts nothing when the plugin is revoked during the awaited route lookup", async () => {
  const sessionKey = `agent:main:${PLUGIN_ID}:direct:user-3`;
  await seedSession(sessionKey, PLUGIN_ID);
  const generation = await capture(sessionKey);
  const lookup = deliveryInfo.extractDeliveryInfo;
  vi.spyOn(deliveryInfo, "extractDeliveryInfo").mockImplementation(async (...args) => {
    const route = await lookup(...args);
    revoke();
    return route;
  });

  await expect(post(generation!, "d")).rejects.toThrow("system owner is no longer active");
  expect(peekSystemEvents(sessionKey)).toEqual([]);
  expect(proof.sent).toEqual([]);
  expect(await notices(sessionKey)).toEqual([]);
});

it("records no row when the plugin is revoked after its channel send", async () => {
  const sessionKey = `agent:main:${PLUGIN_ID}:direct:user-4`;
  await seedSession(sessionKey, PLUGIN_ID);
  const generation = await capture(sessionKey);
  proof.afterSend = revoke;

  await expect(post(generation!, "e")).rejects.toThrow("system owner is no longer active");
  // The provider already accepted the message; it cannot be recalled.
  expect(proof.sent).toMatchObject([{ to: "user-1", payload: { text: "Job e finished." } }]);
  expect(await notices(sessionKey)).toEqual([]);
});

it.each([
  ["has no channel route", undefined],
  ["routes to a channel no plugin delivers", "retired-channel"],
])("records a transcript-only notice when the session %s", async (_case, channel) => {
  const sessionKey = `agent:main:notice-transcript-only:${channel ?? "none"}`;
  await seedSession(sessionKey, channel);
  const generation = await capture(sessionKey);

  await expect(post(generation!, "b")).resolves.toEqual({ status: "posted", delivered: false });
  expect(proof.sent).toEqual([]);
  expect(await notices(sessionKey)).toEqual([{ id: "b" }]);
});

it("skips a session reset after the plugin captured its generation", async () => {
  const sessionKey = `agent:main:${PLUGIN_ID}:direct:user-2`;
  await seedSession(sessionKey, PLUGIN_ID);
  const generation = await capture(sessionKey);
  await seedSession(sessionKey, PLUGIN_ID, "r2");

  await expect(post(generation!, "c")).resolves.toEqual({
    status: "skipped",
    reason: "session-changed",
  });
  expect(proof.sent).toEqual([]);
  expect(await notices(sessionKey)).toEqual([]);
});

it("records a transcript-only notice for a channel the caller skips", async () => {
  const sessionKey = `agent:main:${PLUGIN_ID}:direct:user-6`;
  await seedSession(sessionKey, PLUGIN_ID);
  const generation = await capture(sessionKey);

  await expect(post(generation!, "g", { skipChannels: [PLUGIN_ID] })).resolves.toEqual({
    status: "posted",
    delivered: false,
  });
  expect(proof.sent).toEqual([]);
  expect(await notices(sessionKey)).toEqual([{ id: "g" }]);
  expect(peekSystemEvents(sessionKey)).toEqual(["Job g context."]);
});

it("delivers a thread-bound session's notice to the session key's thread", async () => {
  const sessionKey = `agent:main:${PLUGIN_ID}:direct:user-7:thread:456`;
  await seedSession(sessionKey, PLUGIN_ID, "r1", "stale-thread");
  const generation = await capture(sessionKey);

  await expect(post(generation!, "h")).resolves.toEqual({ status: "posted", delivered: true });
  expect(proof.sent).toMatchObject([{ to: "user-1", threadId: "456" }]);
  expect(await notices(sessionKey)).toEqual([{ id: "h" }]);
});

it("skips a session reset during the delivery route lookup", async () => {
  const sessionKey = `agent:main:${PLUGIN_ID}:direct:user-8`;
  await seedSession(sessionKey, PLUGIN_ID);
  const generation = await capture(sessionKey);
  const lookup = deliveryInfo.extractDeliveryInfo;
  vi.spyOn(deliveryInfo, "extractDeliveryInfo").mockImplementation(async (...args) => {
    const route = await lookup(...args);
    await seedSession(sessionKey, PLUGIN_ID, "r2");
    return route;
  });

  await expect(post(generation!, "i")).resolves.toEqual({
    status: "skipped",
    reason: "session-changed",
  });
  expect(peekSystemEvents(sessionKey)).toEqual([]);
  expect(proof.sent).toEqual([]);
  expect(await notices(sessionKey)).toEqual([]);
});

it("reads the session generation off the main thread and observes a committed reset", async () => {
  const sessionKey = `agent:main:${PLUGIN_ID}:direct:user-9`;
  await seedSession(sessionKey, undefined);
  // The transcript writer is not under test; only the generation reads are pinned. Statement-level
  // observation also sees reads through statements cached before the observer attached.
  const append = vi
    .spyOn(transcriptRuntime, "appendAssistantMessageToSessionTranscript")
    .mockResolvedValue({ ok: false, reason: "not under test" });
  const sql = observeSqliteReadSql(StatementSync.prototype);
  const reads = () =>
    sql.queries.filter((query) => /\b(?:session_nodes|session_windows)\b/iu.test(query));
  try {
    const generation = await capture(sessionKey);
    await post(generation!, "j", undefined);
    expect(append).toHaveBeenCalledOnce();
    expect(reads()).toEqual([]);
    await seedSession(sessionKey, undefined, "r2");
    sql.queries.length = 0;
    await expect(post(generation!, "j", undefined)).resolves.toEqual({
      status: "skipped",
      reason: "session-changed",
    });
    expect(append).toHaveBeenCalledOnce();
    expect(reads()).toEqual([]);
  } finally {
    sql.restore();
  }
});
