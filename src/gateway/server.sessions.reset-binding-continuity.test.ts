import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { afterEach, expect, test, vi } from "vitest";
import { disposeAcpSessionManager, getAcpSessionManager } from "../acp/control-plane/manager.js";
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "../acp/runtime/registry.js";
import { seedCanonicalAcpSessionMeta } from "../acp/runtime/session-meta-fixture.test-support.js";
import { readAcpSessionMeta } from "../acp/runtime/session-meta.js";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import { resolveRuntimeConversationBindingRouteAsync } from "../channels/plugins/binding-routing.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRuntimeMock } from "../plugin-sdk/channel-test-helpers.js";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "../plugin-sdk/plugin-state-test-runtime.js";
import type { PluginHookSessionEndEvent } from "../plugins/hook-types.js";
import { createHookRunner } from "../plugins/hooks.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  sessionStoreEntry,
  setSessionLifecycleHookRunnerForTest,
  setupGatewaySessionsHandlerTestHarness,
  threadBindingMocks,
} from "./test/server-sessions.test-helpers.js";

type TelegramBindingManager = {
  stop: () => Promise<void>;
  getByConversationId: (conversationId: string) => unknown;
};
type TelegramRuntimeApi = {
  setTelegramRuntime: (runtime: ReturnType<typeof createPluginRuntimeMock>) => void;
  createTelegramThreadBindingManager: (params: {
    cfg: OpenClawConfig;
    persist: boolean;
    enableSweeper: boolean;
  }) => Promise<TelegramBindingManager>;
};
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
let manager: TelegramBindingManager;

vi.unmock("../acp/control-plane/manager.js");
vi.unmock("../acp/runtime/registry.js");

afterEach(async () => {
  await disposeAcpSessionManager("continuity-test");
  unregisterAcpRuntimeBackend("synthetic");
  await manager?.stop();
  resetPluginStateStoreForTests();
  threadBindingMocks.unbindThreadBindingsBySessionKey.mockReset();
  vi.unstubAllEnvs();
});

test.each([
  { reason: "new", mode: "persistent" },
  { reason: "reset", mode: "oneshot" },
] as const)(
  "Gateway $reason retains bound Telegram ACP $mode routing across the generation boundary",
  async ({ reason, mode }) => {
    const { storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:acp:continuity";
    await writeSessionStore({
      entries: { [sessionKey]: sessionStoreEntry("continuity", { lifecycleRevision: "before" }) },
    });
    seedCanonicalAcpSessionMeta({
      sessionKey,
      meta: {
        backend: "synthetic",
        agent: "codex",
        runtimeSessionName: "runtime:continuity",
        mode,
        state: "idle",
        lastError: "previous-runtime-error",
        identity: {
          state: "resolved",
          acpxSessionId: "old-runtime",
          source: "status",
          lastUpdatedAt: 1,
        },
        lastActivityAt: Date.now(),
      },
    });
    const prepareFreshSession = vi.fn(async () => {});
    const backendTurns: string[] = [];
    let runtimeGeneration = 0;
    const runtime: AcpRuntime = {
      ownerAwareSessions: 1,
      ensureSession: async (input) => ({
        ...input,
        backend: "synthetic",
        runtimeSessionName: `runtime:generation:${++runtimeGeneration}`,
      }),
      async *runTurn({ handle, text }) {
        backendTurns.push(handle.runtimeSessionName);
        yield { type: "text_delta", text: `synthetic:${text}` };
        yield { type: "done" };
      },
      cancel: async () => {},
      close: async () => {},
      prepareFreshSession,
    };
    registerAcpRuntimeBackend({
      id: "synthetic",
      runtime,
    });
    const bindingModule = await vi.importActual<
      typeof import("../infra/outbound/session-binding-service.js")
    >("../infra/outbound/session-binding-service.js");
    const service = bindingModule.getSessionBindingService();
    // The shared reset harness intercepts unbind; delegate to the real owner here.
    vi.mocked<typeof service.unbind>(
      threadBindingMocks.unbindThreadBindingsBySessionKey,
    ).mockImplementation(service.unbind);
    const telegram = await loadBundledPluginFacade<TelegramRuntimeApi>({
      pluginId: "telegram",
      artifactBasename: "runtime-api.ts",
    });
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", `${process.cwd()}/extensions`);
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "0");
    const { telegramPlugin } = await loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
      pluginId: "telegram",
      artifactBasename: "channel-plugin-api.ts",
    });
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "telegram", plugin: telegramPlugin, source: "synthetic", origin: "bundled" },
      ]),
    );
    telegram.setTelegramRuntime(
      createPluginRuntimeMock({
        state: {
          openKeyedStore: (options) => createPluginStateKeyedStoreForTests("telegram", options),
        },
      }),
    );
    const { getRuntimeConfig } = await getGatewayConfigModule();
    const cfg = getRuntimeConfig();
    const turnCfg = {
      ...cfg,
      acp: { enabled: true, backend: "synthetic", dispatch: { enabled: true } },
    };
    const runNextBackendTurn = async (key: string, requestId: string) => {
      const admission = prepareSystemAgentRunAdmission(
        turnCfg,
        requestId,
        "main",
        "continuity-test",
      );
      const output: string[] = [];
      try {
        await getAcpSessionManager().runTurn({
          admittedRunContext: await admission.admit("acp"),
          cfg: turnCfg,
          sessionKey: key,
          agentId: "main",
          text: requestId,
          mode: "prompt",
          provenance: "system",
          requestId,
          onEvent: (event) => {
            if (event.type === "text_delta") {
              output.push(event.text);
            }
          },
        });
      } finally {
        admission.close();
      }
      expect(output.join("")).toBe(`synthetic:${requestId}`);
    };
    const conversation = {
      channel: "telegram",
      accountId: "default",
      conversationId: "-100123456:topic:2",
    };
    const managerParams = { cfg, persist: true, enableSweeper: false };
    manager = await telegram.createTelegramThreadBindingManager(managerParams);
    await service.bind({ targetSessionKey: sessionKey, targetKind: "session", conversation });
    const ordinaryRoute = {
      agentId: "main",
      channel: "telegram",
      accountId: "default",
      sessionKey: "agent:main:telegram:group:-100123456:topic:2",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session" as const,
      matchedBy: "default" as const,
    };
    const routeNextMessage = () =>
      resolveRuntimeConversationBindingRouteAsync({ route: ordinaryRoute, conversation });
    const before = await routeNextMessage();
    expect(before.route.sessionKey).toBe(sessionKey);
    await runNextBackendTurn(before.route.sessionKey, "before-reset");
    const ended = createDeferredCore();
    const started = createDeferredCore();
    const boundaries: string[] = [];
    setSessionLifecycleHookRunnerForTest(
      createHookRunner({
        plugins: [{ id: "continuity-observer", status: "loaded" }],
        hooks: [],
        typedHooks: [
          {
            pluginId: "continuity-observer",
            hookName: "session_end",
            source: "synthetic",
            handler: async (event: PluginHookSessionEndEvent) => {
              boundaries.push(event.reason ?? "unknown");
              ended.resolve();
            },
          },
          {
            pluginId: "continuity-observer",
            hookName: "session_start",
            source: "synthetic",
            handler: async () => {
              boundaries.push("start");
              started.resolve();
            },
          },
          {
            pluginId: "continuity-observer",
            hookName: "subagent_ended",
            source: "synthetic",
            handler: async () => {
              boundaries.push("unbound");
            },
          },
        ],
      }),
    );
    const reset = await directSessionReq("sessions.reset", {
      key: before.route.sessionKey,
      reason,
    });
    expect(reset.ok).toBe(true);
    expect((await routeNextMessage()).route.sessionKey).toBe(sessionKey);
    await Promise.all([ended.promise, started.promise]);
    expect(boundaries.toSorted()).toEqual([reason, "start"].toSorted());
    expect(loadSessionEntry({ storePath, sessionKey })?.lifecycleRevision).not.toBe("before");
    expect(readAcpSessionMeta({ sessionKey })).toMatchObject({
      state: "idle",
      mode,
      identity: { state: "pending" },
    });
    expect(readAcpSessionMeta({ sessionKey })?.lastError).toBeUndefined();
    expect(readAcpSessionMeta({ sessionKey })?.identity?.acpxSessionId).toBeUndefined();
    await manager.stop();
    manager = await telegram.createTelegramThreadBindingManager(managerParams);
    expect((await routeNextMessage()).route.sessionKey).toBe(sessionKey);
    await runNextBackendTurn((await routeNextMessage()).route.sessionKey, "after-reset");
    expect(backendTurns).toHaveLength(2);
    expect(backendTurns[1]).not.toBe(backendTurns[0]);
    if (reason === "new") {
      await service.unbind({ targetSessionKey: sessionKey, reason: "manual" });
    } else {
      const deleted = await directSessionReq("sessions.delete", { key: sessionKey });
      expect(deleted.ok).toBe(true);
    }
    expect((await routeNextMessage()).route.sessionKey).toBe(ordinaryRoute.sessionKey);
    await manager.stop();
    manager = await telegram.createTelegramThreadBindingManager(managerParams);
    expect(manager.getByConversationId(conversation.conversationId)).toBeUndefined();
  },
);
