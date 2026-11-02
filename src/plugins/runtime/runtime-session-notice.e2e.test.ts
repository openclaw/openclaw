import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
      sent.push({ to: ctx.to, payload: ctx.payload });
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
  sent: Array<{ to: string; payload: Record<string, unknown> }>;
};

let state: OpenClawTestState;
let pluginDir: string;
let proof: Proof;
let storePath: string;

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
  proof = (globalThis as { noticeProofFixture?: Proof }).noticeProofFixture!;
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
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
              context: { channel, accountId: "default", to: "user-1" },
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

function post(generation: NonNullable<Awaited<ReturnType<typeof capture>>>, id: string) {
  return proof.runtime.agent.session.postNotice({
    generation,
    notice: { type: "done", text: `Job ${id} finished.`, data: { id }, presentation },
    idempotencyKey: `${PLUGIN_ID}:${id}`,
    deliver: {},
  });
}

function capture(sessionKey: string) {
  return proof.runtime.agent.session.captureGeneration({ agentId: "main", sessionKey });
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
