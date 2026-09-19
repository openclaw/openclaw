import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  LegacyPluginSdkResourceHost,
  bindLegacyPluginSdkResourceHost,
  getLegacyPluginSdkResourceHost,
} from "../plugins/legacy-sdk-resource-host.js";
import type { PluginLoadOptions } from "../plugins/loader-types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import * as gatewayRequestScopeModule from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { loadGatewayPlugins } from "./server-plugins.js";

const loadOpenClawPlugins = vi.hoisted(() =>
  vi.fn<(options: PluginLoadOptions) => ReturnType<typeof createEmptyPluginRegistry>>(),
);
const dispatchReplyFromConfig = vi.hoisted(() =>
  vi.fn(async () => ({ counts: {}, queuedFinal: false })),
);
vi.mock("../plugins/loader.js", () => ({ loadOpenClawPlugins }));
vi.mock("../auto-reply/reply/dispatch-from-config.js", () => ({
  dispatchReplyFromConfig,
  dispatchLowLevelChannelReplyFromConfig: dispatchReplyFromConfig,
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

test("captures retired plugin reply owners through their canonical Gateway binding", async () => {
  const { admitReplyTurn } = await import("../auto-reply/reply/reply-turn-admission.js");
  const { captureGatewayReplyRunRestartAbort } =
    await import("../auto-reply/reply/reply-run-registry.js");
  const { captureGatewaySessionWorkAdmissions } =
    await import("../sessions/session-lifecycle-admission.js");
  const { replaceSessionEntry } = await import("../config/sessions/session-accessor.js");
  const { closeOpenClawAgentDatabasesForTest } = await import("../state/openclaw-agent-db.js");
  const stateDir = tempDirs.make("openclaw-plugin-restart-owner-");
  const storePath = path.join(stateDir, "sessions.json");
  const context = { getRuntimeConfig: () => ({}) } as GatewayRequestContext;
  const closingResolver = vi.fn(() => context);
  const otherResolver = vi.fn(() => context);
  const closingSdkHost = new LegacyPluginSdkResourceHost();
  const otherSdkHost = new LegacyPluginSdkResourceHost();
  const foreignSdkHost = new LegacyPluginSdkResourceHost();
  bindLegacyPluginSdkResourceHost(closingResolver, closingSdkHost);
  bindLegacyPluginSdkResourceHost(otherResolver, otherSdkHost);
  const databases = [new DatabaseSync(":memory:"), new DatabaseSync(":memory:")];
  const inspections = databases.map((database) => {
    const inspection = new PluginRegistryInspectionResources(async () => {});
    inspection.attach(createEmptyPluginRegistry());
    inspection.register("sdk-wrapper", { id: "native", dispose: () => database.close() });
    return inspection;
  });
  const operations: import("../auto-reply/reply/reply-run-registry.js").ReplyOperation[] = [];
  const runtimes: ReturnType<typeof loadGatewayPlugins>[] = [];
  try {
    for (const [name, resolver, sdkHost, inspection] of [
      ["closing", closingResolver, closingSdkHost, inspections[0]!],
      ["other", otherResolver, otherSdkHost, inspections[1]!],
    ] as const) {
      const sessionKey = `agent:main:plugin-${name}`;
      await replaceSessionEntry(
        { storePath, sessionKey },
        { sessionId: name, updatedAt: Date.now() },
      );
      loadOpenClawPlugins.mockReturnValue(createEmptyPluginRegistry());
      runtimes.push(
        loadGatewayPlugins({
          loadIntent: "startup",
          cfg: {},
          autoEnabledReasons: {},
          workspaceDir: stateDir,
          log,
          baseMethods: [],
          pluginIds: ["test-channel"],
          resolveGatewayContext: resolver,
        }),
      );
      const runtimeOptions = loadOpenClawPlugins.mock.calls.at(-1)?.[0].runtimeOptions;
      const dispatch = runtimeOptions?.dispatchReplyFromConfig;
      if (!dispatch) {
        throw new Error("Expected bound channel dispatch");
      }
      dispatchReplyFromConfig.mockImplementationOnce(async () => {
        const selectedHost = getLegacyPluginSdkResourceHost();
        expect(selectedHost).toBe(sdkHost);
        selectedHost.adopt(inspection, inspection.retain());
        const admission = await admitReplyTurn({
          sessionKey,
          sessionId: name,
          storePath,
          kind: "visible",
          resetTriggered: false,
        });
        if (admission.status !== "owned") {
          throw new Error("Expected an owned reply");
        }
        operations.push(admission.operation);
        return { counts: {}, queuedFinal: false };
      });
      const channel = createPluginRuntime(runtimeOptions).channel;
      await foreignSdkHost.run(() =>
        channel.inbound.run({
          channel: "test-channel",
          raw: "hello",
          adapter: {
            ingest: (raw) => ({ id: `message-${name}`, rawText: raw }),
            resolveTurn: () => ({
              channel: "test-channel",
              cfg: { session: { store: storePath } },
              route: { agentId: "main", sessionKey },
              ctxPayload: channel.reply.finalizeInboundContext({
                Body: "hello",
                SessionKey: sessionKey,
                Provider: "test-channel",
                From: "peer",
                To: "bot",
              }),
              delivery: { deliver: async () => ({ visibleReplySent: true }) },
            }),
          },
        }),
      );
      await inspection.release();
    }
    const capturedResolver = gatewayRequestScopeModule.getGatewayContextResolver(operations[0]!);
    expect(capturedResolver?.()).toBe(context);
    runtimes[0]!.retireGatewayRuntimeBindings();
    expect(capturedResolver?.()).toBeUndefined();
    closingResolver.mockImplementation(() => {
      throw new Error("Retired resolver must not be invoked");
    });
    closingResolver.mockClear();
    otherResolver.mockClear();
    await closingSdkHost.close();
    expect(databases[0]!.isOpen).toBe(false);
    expect(databases[1]!.isOpen).toBe(true);
    foreignSdkHost.run(() =>
      gatewayRequestScopeModule.withPluginRuntimeGatewayContextResolver(capturedResolver, () => {
        const selectedHost = getLegacyPluginSdkResourceHost();
        expect(selectedHost).toBe(closingSdkHost);
        expect(() => selectedHost.assertOpen()).toThrow("SDK resource host is closed");
      }),
    );
    expect(closingResolver).not.toHaveBeenCalled();
    const admissions = captureGatewaySessionWorkAdmissions(closingResolver);
    const aborted = captureGatewayReplyRunRestartAbort(closingResolver)(() => {});
    expect({
      closing: admissions.isActive({
        scope: storePath,
        sessionKey: "agent:main:plugin-closing",
        sessionId: "closing",
      }),
      other: admissions.isActive({
        scope: storePath,
        sessionKey: "agent:main:plugin-other",
        sessionId: "other",
      }),
      aborted,
      signals: operations.map((operation) => operation.abortSignal.aborted),
    }).toEqual({ closing: true, other: false, aborted: 1, signals: [true, false] });
    expect(otherResolver).not.toHaveBeenCalled();

    // A restart snapshot must not cancel a successor admitted under the same owner and key.
    const abortPriorOther = captureGatewayReplyRunRestartAbort(otherResolver);
    operations[1]!.complete();
    const replacement = await gatewayRequestScopeModule.withPluginRuntimeGatewayContextResolver(
      otherResolver,
      () =>
        admitReplyTurn({
          sessionKey: "agent:main:plugin-other",
          sessionId: "other",
          storePath,
          kind: "visible",
          resetTriggered: false,
        }),
    );
    if (replacement.status !== "owned") {
      throw new Error("Expected replacement reply admission");
    }
    operations.push(replacement.operation);
    expect(abortPriorOther(() => {})).toBe(0);
    expect(replacement.operation.abortSignal.aborted).toBe(false);
  } finally {
    operations.forEach((operation) => operation.complete());
    runtimes.forEach((runtime) => runtime.retireGatewayRuntimeBindings());
    await Promise.allSettled([
      closingSdkHost.close(),
      otherSdkHost.close(),
      foreignSdkHost.close(),
      ...inspections.map((inspection) => inspection.release()),
    ]);
    for (const database of databases) {
      if (database.isOpen) {
        database.close();
      }
    }
    await Promise.resolve();
    closeOpenClawAgentDatabasesForTest();
  }
});
