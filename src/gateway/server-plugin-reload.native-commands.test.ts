import "./server-startup-module-mocks.test-support.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot } from "../config/io.js";
import { createPluginCommandRuntime } from "../plugins/plugin-command-runtime.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { clearActivePluginRegistry, resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { clearTranscriptCapturesForTest } from "../transcripts/capture.test-support.js";
import {
  createPluginReloadRecoveryFixture,
  createRecoveryChannelManager,
  waitForChannelAbort,
} from "./server-plugin-reload.recovery.test-support.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const cleanups: Array<() => Promise<void>> = [];
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;

beforeEach(async () => {
  vi.clearAllMocks();
  resetPluginRuntimeStateForTest();
  resetGatewayWorkAdmission();
  state = await createOpenClawTestState({ scenario: "minimal", label: "native-command-reload" });
});

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
    await clearActivePluginRegistry();
  } finally {
    await clearTranscriptCapturesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    clearRuntimeConfigSnapshot();
    resetGatewayWorkAdmission();
    clearPluginMetadataLifecycleCaches();
    await state.cleanup();
  }
});

it("refreshes only native command channels when an unrelated plugin reloads", async () => {
  const starts: string[] = [];
  const context = { channel: "native", isAuthorizedSender: true, commandBody: "/go", config: {} };
  let runRetained = async (): Promise<unknown> => undefined;
  const fixture = await createPluginReloadRecoveryFixture(
    { cleanups, logMocks: log },
    {
      abortOnCandidateStart: false,
      register(api, owner) {
        if (owner !== "sibling") {
          return;
        }
        api.registerCommand({
          name: "go",
          description: "k",
          handler: async () => ({ text: "ok" }),
        });
        for (const id of ["native", "plain"]) {
          const capabilities = { chatTypes: ["direct" as const], nativeCommands: id === "native" };
          const startAccount = async ({ abortSignal }: { abortSignal: AbortSignal }) => {
            const cmd = createPluginCommandRuntime().listNativeCandidates(id)[0]?.prepareDispatch();
            assert(cmd?.kind === "plugin");
            starts.push(id);
            runRetained = () => cmd.execute(context);
            await waitForChannelAbort(abortSignal);
          };
          const base = createChannelTestPluginBase({ id, capabilities });
          api.registerChannel({ plugin: { ...base, gateway: { startAccount } } });
        }
      },
    },
  );
  const manager = createRecoveryChannelManager(fixture);
  fixture.runtime.channelManager = manager;
  await manager.startChannel("plain");
  await manager.startChannel("native");
  await fixture.reload();
  await Promise.all([manager.stopChannel("native"), manager.stopChannel("plain")]);
  // Only the native command channel restarts, and its new handler runs the retained command.
  expect(starts).toEqual(["plain", "native", "native"]);
  await expect(runRetained()).resolves.toEqual({ text: "ok" });
});
