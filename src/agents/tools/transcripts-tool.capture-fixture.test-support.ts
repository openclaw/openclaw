import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createTranscriptsAutoStartService } from "../../transcripts/auto-start.js";
import type { TranscriptsRuntimeContext } from "../../transcripts/capture.js";
import type { TranscriptSourceProvider } from "../../transcripts/provider-types.js";
import { TranscriptsStore } from "../../transcripts/store.js";
import { createTranscriptsTool } from "./transcripts-tool.js";

export type CaptureStart = NonNullable<TranscriptSourceProvider["start"]>;
export type CaptureStop = NonNullable<TranscriptSourceProvider["stop"]>;
export type AutoStarts = NonNullable<NonNullable<OpenClawConfig["transcripts"]>["autoStart"]>;

export function captureFixture(
  state: { stateDir: string; store?: TranscriptsStore },
  providerOverrides: Partial<TranscriptSourceProvider> = {},
  context: Omit<Partial<TranscriptsRuntimeContext>, "stateDir" | "logger"> = {},
) {
  const { stateDir } = state;
  const requests: Parameters<CaptureStart>[0][] = [];
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
  const tool = (extra: Partial<Parameters<typeof createTranscriptsTool>[0]> = {}) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const { config, agentId, caller, assertCallerActive } = ctx;
    return createTranscriptsTool({ config, agentId, caller, assertCallerActive, ...extra });
  };
  const instance = tool();
  const execute = (params: Record<string, unknown>, signal?: AbortSignal) =>
    instance.execute("capture-fixture", params, signal);
  return {
    provider,
    requests,
    logger,
    ctx,
    store,
    newStore,
    tool,
    execute,
    action: (action: string, sessionId = "notes") => execute({ action, sessionId }),
    session: async (id = "notes") => expectDefined(await store.readSession(id), "missing capture"),
    successfulStart,
    successfulStop,
    service: (autoStart: AutoStarts, config: OpenClawConfig = {}) =>
      createTranscriptsAutoStartService({
        ...ctx,
        config: { ...config, transcripts: { autoStart } },
      }),
    status: (active: unknown) =>
      expect(execute({ action: "status" })).resolves.toMatchObject({ details: { active } }),
    scope: <T>(run: () => T) => withPluginRuntimeRegistryScope(registry, run),
  };
}
