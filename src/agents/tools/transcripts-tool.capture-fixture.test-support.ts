import path from "node:path";
import { expect, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createTranscriptsAutoStartService } from "../../transcripts/auto-start.js";
import type { TranscriptsRuntimeContext } from "../../transcripts/capture.js";
import type {
  TranscriptSourceProvider,
  TranscriptStartRequest,
} from "../../transcripts/provider-types.js";
import { TranscriptsStore } from "../../transcripts/store.js";
import { createTranscriptsTool } from "./transcripts-tool.js";

export type CaptureStart = NonNullable<TranscriptSourceProvider["start"]>;
export type CaptureStop = NonNullable<TranscriptSourceProvider["stop"]>;
export type AutoStarts = NonNullable<NonNullable<OpenClawConfig["transcripts"]>["autoStart"]>;

export function captureGate() {
  const entered = createDeferred();
  const release = createDeferred();
  return {
    entered: entered.promise,
    release: release.resolve,
    wait: async () => {
      entered.resolve();
      await release.promise;
    },
  };
}

export function captureFixture(
  state: { stateDir: string; store?: TranscriptsStore },
  providerOverrides: Partial<TranscriptSourceProvider> = {},
  context: Omit<Partial<TranscriptsRuntimeContext>, "stateDir" | "logger"> = {},
) {
  const { stateDir } = state;
  const requests: TranscriptStartRequest[] = [];
  const logger = { warn: vi.fn<(message: string) => void>() };
  const newStore = () =>
    new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
  const store = state.store ?? newStore();
  const successfulStart = () =>
    vi.fn<CaptureStart>(async (request) => {
      requests.push(request);
      return { ok: true, session: request.session };
    });
  const successfulStop: CaptureStop = async ({ sessionId }) => ({ ok: true, sessionId });
  const provider: TranscriptSourceProvider = {
    id: "capture",
    name: "Capture",
    sourceKinds: ["live-audio"],
    start: successfulStart(),
    stop: vi.fn(successfulStop),
    ...providerOverrides,
  };
  const registry = createEmptyPluginRegistry();
  registry.transcriptSourceProviders.push({
    pluginId: provider.id,
    provider,
    source: import.meta.url,
  });
  const ctx: TranscriptsRuntimeContext = {
    stateDir,
    logger,
    caller: { kind: "operator", source: "local" },
    ...context,
  };
  const tool = (extra: Partial<TranscriptsRuntimeContext> = {}) =>
    createTranscriptsTool({ ...ctx, ...extra });
  const instance = tool();
  const execute = (params: Record<string, unknown>, signal?: AbortSignal) =>
    instance.execute("capture-fixture", params, signal);
  const action = (operation: string, sessionId = "notes") =>
    execute({ action: operation, sessionId });
  const session = async (id = "notes") => {
    const value = await store.readSession(id);
    if (!value) {
      throw new Error("missing capture");
    }
    return value;
  };
  const service = (autoStart: AutoStarts, config: OpenClawConfig = {}) =>
    createTranscriptsAutoStartService({
      ...ctx,
      config: { ...config, transcripts: { autoStart } },
    });
  return {
    provider,
    requests,
    logger,
    ctx,
    store,
    newStore,
    tool,
    execute,
    action,
    session,
    successfulStart,
    successfulStop,
    service,
    status: (active: unknown) =>
      expect(execute({ action: "status" })).resolves.toMatchObject({ details: { active } }),
    scope: <T>(run: () => T) => withPluginRuntimeRegistryScope(registry, run),
  };
}
