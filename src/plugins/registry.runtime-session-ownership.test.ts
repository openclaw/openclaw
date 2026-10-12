import { describe, expect, it, vi } from "vitest";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { createPluginRecord } from "./loader-records.js";
import { revokePluginRecord } from "./registry-lifecycle.js";
import { createRuntimeTestRegistry } from "./registry-runtime.test-helpers.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { PluginRuntime } from "./runtime/types.js";

type RunParams = Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0];

function createApis(runtime: PluginRuntime, config: OpenClawConfig = {}) {
  const registry = createRuntimeTestRegistry(runtime);
  return (id: string) =>
    registry.createApi(
      createPluginRecord({
        id,
        source: `/plugins/${id}/index.js`,
        origin: "bundled",
        enabled: true,
        configSchema: false,
      }),
      { config },
    );
}

describe("plugin registry runtime session ownership", () => {
  it.each(["upsert", "route"] as const)(
    "refuses a prepared %s when its plugin retires before worker admission",
    async (operation) => {
      const runtime = createPluginRuntime();
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const original = { sessionId: "managed", updatedAt: 1, label: "original" };
      const delivery = normalizeSessionDeliveryState({
        context: { channel: "slack", to: "C123" },
      });
      let stored: SessionEntry = original;
      runtime.agent.session.getSessionEntryAsync = async () => stored;
      runtime.agent.session.upsertSessionEntry = async ({ entry }) => {
        entered.resolve();
        await resume.promise;
        stored = entry;
      };
      runtime.agent.session.prepareSessionEntryPatch = async (params) => {
        const patch = await params.prepare(stored, { existingEntry: stored });
        entered.resolve();
        await resume.promise;
        if (params.authority?.kind === "host") {
          params.authority.assertCurrent();
        }
        if (params.authority?.kind === "source") {
          params.authority.source();
        }
        if (patch) {
          stored = { ...stored, ...patch };
        }
        return stored;
      };
      runtime.channel.session.updateLastRoute = async () => {
        entered.resolve();
        await resume.promise;
        stored = { ...stored, delivery };
        return stored;
      };
      runtime.channel.session.updateLastRouteWithAuthority = async ({ authority }) => {
        entered.resolve();
        await resume.promise;
        if (authority.kind === "host") {
          authority.assertCurrent();
        } else {
          authority.source();
        }
        stored = { ...stored, delivery };
        return stored;
      };
      const registry = createRuntimeTestRegistry(runtime);
      const record = createPluginRecord({
        id: "managed-writer",
        source: "/plugins/managed-writer/index.js",
        origin: "bundled",
        enabled: true,
        configSchema: false,
      });
      const api = registry.createApi(record, { config: {} });
      const writing =
        operation === "upsert"
          ? api.runtime.agent.session.upsertSessionEntry({
              sessionKey: "agent:main:managed",
              entry: { ...original, label: "must not persist" },
            })
          : api.runtime.channel.session.updateLastRoute({
              sessionKey: "agent:main:managed",
              storePath: "/synthetic/sessions.json",
              channel: "slack",
            });
      await entered.promise;
      const refused = expect(writing).rejects.toThrow("runtime is no longer active");
      revokePluginRecord(registry.registry, record);
      resume.resolve();
      await refused;
      expect(stored).toEqual(original);
    },
  );

  it.each(["key", "id"] as const)(
    "fences a managed asynchronous %s read when its plugin retires before disclosure",
    async (selection) => {
      const runtime = createPluginRuntime();
      const pending = createDeferredCore<SessionEntry | undefined>();
      const entry = { sessionId: "managed", updatedAt: 1 };
      runtime.agent.session.getSessionEntryAsync = () => pending.promise;
      runtime.agent.session.getSessionEntryByIdAsync = async () => {
        const selectedEntry = await pending.promise;
        return selectedEntry
          ? { sessionKey: "agent:main:managed", entry: selectedEntry }
          : undefined;
      };
      const registry = createRuntimeTestRegistry(runtime);
      const record = createPluginRecord({
        id: "managed-reader",
        source: "/plugins/managed-reader/index.js",
        origin: "bundled",
        enabled: true,
        configSchema: false,
      });
      const api = registry.createApi(record, { config: {} });
      const reading =
        selection === "key"
          ? api.runtime.agent.session.getSessionEntryAsync({ sessionKey: "agent:main:managed" })
          : api.runtime.agent.session.getSessionEntryByIdAsync({
              agentId: "main",
              sessionId: "managed",
            });
      revokePluginRecord(registry.registry, record);
      pending.resolve(entry);
      await expect(reading).rejects.toThrow("runtime is no longer active");
    },
  );

  it.each(["factory", "read", "snapshot"] as const)(
    "revokes a session listing reader when its plugin retires during %s",
    async (phase) => {
      const runtime = createPluginRuntime();
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const entries = [
        { sessionKey: "agent:main:shared", entry: { sessionId: "shared", updatedAt: 1 } },
      ];
      const assertSourceCurrent = vi.fn();
      const scopes: Array<string | undefined> = [];
      const waitAt = async (boundary: "factory" | "read") => {
        scopes.push(getPluginRuntimeGatewayRequestScope()?.pluginId);
        if (phase === boundary) {
          entered.resolve();
          await resume.promise;
        }
      };
      runtime.agent.session.createSessionEntryListReader = async () => {
        await waitAt("factory");
        return async () => {
          await waitAt("read");
          return { entries, assertCurrent: assertSourceCurrent };
        };
      };
      const registry = createRuntimeTestRegistry(runtime);
      const record = createPluginRecord({
        id: "session-share",
        source: "/plugins/session-share/index.js",
        origin: "bundled",
        enabled: true,
        configSchema: false,
      });
      const api = registry.createApi(record, { config: {} });
      const factory = api.runtime.agent.session.createSessionEntryListReader({
        agentId: "main",
        storePath: "/synthetic/sessions.json",
      });
      const pending =
        phase === "factory"
          ? factory
          : factory.then(async (read) => {
              const snapshot = await read();
              expect(snapshot.entries).toBe(entries);
              snapshot.assertCurrent();
              expect(assertSourceCurrent).toHaveBeenCalledOnce();
              if (phase === "snapshot") {
                revokePluginRecord(registry.registry, record);
                expect(snapshot.assertCurrent).toThrow("runtime is no longer active");
                await expect(read()).rejects.toThrow("runtime is no longer active");
              }
            });
      if (phase === "snapshot") {
        await pending;
      } else {
        await entered.promise;
        const refused = expect(pending).rejects.toThrow("runtime is no longer active");
        revokePluginRecord(registry.registry, record);
        resume.resolve();
        await refused;
        expect(assertSourceCurrent).not.toHaveBeenCalled();
      }
      expect(scopes).toEqual(
        phase === "factory" ? ["session-share"] : ["session-share", "session-share"],
      );
    },
  );

  it("resolves persisted runtime requests at the plugin execution boundary", async () => {
    const sessionKey = "agent:worker:voice";
    const entry: SessionEntry = {
      sessionId: "voice-session",
      updatedAt: 1,
      pluginOwnerId: "voice-call",
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      modelProvider: "anthropic",
      model: "previous-model",
    };
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: "anthropic/default-model" } },
        entries: { worker: { model: { primary: "openai/worker-model" } } },
      },
    };
    const runtime = createPluginRuntime();
    runtime.config.current = () => cfg;
    runtime.agent.session.getSessionEntryAsync = vi.fn(async () => entry);
    runtime.agent.session.listSessionEntriesAsync = vi.fn(async () => [{ sessionKey, entry }]);
    let executionScope = getPluginRuntimeGatewayRequestScope();
    const runEmbeddedAgent = vi.fn<PluginRuntime["agent"]["runEmbeddedAgent"]>(async () => {
      executionScope = getPluginRuntimeGatewayRequestScope();
      return { meta: { durationMs: 0 } };
    });
    Object.defineProperty(runtime.agent, "runEmbeddedAgent", { value: runEmbeddedAgent });
    const createApi = createApis(runtime, cfg);
    const api = createApi("voice-call");
    const otherApi = createApi("other-plugin");
    const runParams = {
      sessionId: entry.sessionId,
      sessionKey,
      agentId: "worker",
      workspaceDir: "/tmp",
      prompt: "continue",
      timeoutMs: 1,
      runId: "voice-run",
      sessionTarget: {
        sessionId: entry.sessionId,
        sessionKey,
        agentId: "worker",
        storePath: "/tmp/sessions.json",
      },
    } satisfies RunParams;
    const cases: Array<{
      name: string;
      storedRuntime?: string;
      request: Partial<RunParams>;
      expected?: string;
    }> = [
      { name: "stored request", storedRuntime: "openclaw", request: {}, expected: "openclaw" },
      { name: "agent default provider", storedRuntime: "codex", request: {}, expected: "codex" },
      {
        name: "request config provider",
        storedRuntime: "codex",
        request: { config: { agents: { defaults: { model: "anthropic/request-model" } } } },
      },
      { name: "incompatible provider", storedRuntime: "codex", request: { provider: "anthropic" } },
      { name: "model-ref provider", storedRuntime: "codex", request: { model: "anthropic/other" } },
      {
        name: "explicit runtime",
        storedRuntime: "codex",
        request: { agentHarnessRuntimeOverride: "openclaw" },
        expected: "openclaw",
      },
      {
        name: "explicit auto",
        storedRuntime: "codex",
        request: { agentHarnessRuntimeOverride: "auto" },
        expected: "auto",
      },
      { name: "detached", storedRuntime: "codex", request: { sessionPersistence: "detached" } },
      { name: "raw model", storedRuntime: "codex", request: { modelRun: true } },
      { name: "observation only", request: {} },
    ];
    for (const scenario of cases) {
      entry.agentRuntimeOverride = scenario.storedRuntime;
      await api.runtime.agent.runEmbeddedAgent({ ...runParams, ...scenario.request });
      const forwarded = runEmbeddedAgent.mock.calls.at(-1)?.[0];
      expect(forwarded?.agentHarnessId, scenario.name).toBeUndefined();
      expect(forwarded?.agentHarnessRuntimeOverride, scenario.name).toBe(scenario.expected);
      expect(executionScope?.pluginId, scenario.name).toBe("voice-call");
    }
    await expect(otherApi.runtime.agent.runEmbeddedAgent(runParams)).rejects.toThrow(
      'owned by plugin "voice-call"',
    );
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(cases.length);
  });

  it("limits locked harness session mutation and execution to the harness owner", async () => {
    const key = {
      reserved: "agent:main:harness:codex:thread-1",
      ordinary: "agent:main:ordinary",
      alias: "agent:main:ordinary-alias",
      noId: "agent:main:ordinary-no-id",
      lockedNoId: "agent:main:locked-no-id",
      locked: "agent:main:ordinary-locked",
      legacy: "agent:main:harness:notes",
      plugin: "agent:main:plugin-owned",
      mixed: "agent:main:harness:codex:mixed-owner",
    };
    const lock = { agentHarnessId: "codex", modelSelectionLocked: true as const };
    const reserved = {
      sessionId: "reserved-session",
      updatedAt: 1,
      ...lock,
      sessionFile: formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId: "reserved-session",
        storePath: "/tmp/sessions.json",
      }),
    };
    const ordinary = { sessionId: "ordinary-session", updatedAt: 1 };
    const locked = { sessionId: "locked-ordinary-session", updatedAt: 1, ...lock };
    const legacy = {
      sessionId: "legacy-prefixed-session",
      updatedAt: 1,
      agentHarnessId: "legacy-runtime",
    };
    const plugin = {
      sessionId: "plugin-owned-session",
      updatedAt: 1,
      ...lock,
      pluginOwnerId: "other-plugin",
    };
    const entries = {
      [key.plugin]: plugin,
      [key.mixed]: { ...plugin, sessionId: "mixed-owner-session" },
      [key.alias]: { sessionId: reserved.sessionId, updatedAt: 1 },
      [key.noId]: { updatedAt: 1 },
      [key.lockedNoId]: { updatedAt: 1, ...lock },
      [key.reserved]: reserved,
      [key.ordinary]: ordinary,
      [key.locked]: locked,
      [key.legacy]: legacy,
    } as unknown as Record<string, SessionEntry>;
    const subagent = {
      complete: vi.fn(async () => ({ text: "completed" })),
      run: vi.fn(async () => ({ runId: "subagent-run" })),
      waitForRun: vi.fn(async () => ({ status: "ok" as const })),
      getSessionMessages: vi.fn(async () => ({ messages: [] })),
      deleteSession: vi.fn(async () => {}),
    } satisfies PluginRuntime["subagent"];
    const runtime = createPluginRuntime({ subagent });
    const session = runtime.agent.session;
    session.getSessionEntryAsync = vi.fn(async (params) => entries[params.sessionKey]);
    session.listSessionEntriesAsync = vi.fn(async () =>
      Object.entries(entries).map(([sessionKey, entry]) => ({ sessionKey, entry })),
    );
    session.patchSessionEntry = vi.fn(async (params) => {
      const entry = entries[params.sessionKey];
      if (!entry) {
        return null;
      }
      const patch = await params.update(structuredClone(entry), {
        existingEntry: structuredClone(entry),
      });
      return patch ? { ...entry, ...patch } : entry;
    });
    session.prepareSessionEntryPatch = vi.fn(async (params) => {
      const existingEntry = entries[params.sessionKey];
      const entry = existingEntry ?? params.fallbackEntry;
      if (!entry) {
        return null;
      }
      const patch = await params.prepare(structuredClone(entry), {
        existingEntry: existingEntry ? structuredClone(existingEntry) : undefined,
      });
      return patch ? { ...entry, ...patch } : entry;
    });
    session.upsertSessionEntry = vi.fn(async () => {});
    session.updateSessionStoreEntry = vi.fn(async (params) => entries[params.sessionKey] ?? null);
    let admissionScope = getPluginRuntimeGatewayRequestScope();
    session.runWithWorkAdmission = vi.fn(async (_params, run) => {
      admissionScope = getPluginRuntimeGatewayRequestScope();
      return await run(new AbortController().signal);
    });
    let embeddedRunScope = getPluginRuntimeGatewayRequestScope();
    const runEmbeddedAgent = vi.fn(async (params: RunParams) => {
      if ("preparedRunAdmission" in params || "admittedRunContext" in params) {
        throw new Error("Plugin embedded-agent execution cannot supply host run authority.");
      }
      embeddedRunScope = getPluginRuntimeGatewayRequestScope();
      return { ok: true };
    }) as unknown as PluginRuntime["agent"]["runEmbeddedAgent"];
    Object.defineProperty(runtime.agent, "runEmbeddedAgent", {
      configurable: true,
      value: runEmbeddedAgent,
    });
    const gatewayRequest = vi.fn(async () => ({ ok: true }));
    runtime.gateway.isAvailable = vi.fn(async () => true);
    runtime.gateway.request = gatewayRequest as unknown as PluginRuntime["gateway"]["request"];
    const createApi = createApis(runtime);
    const owner = createApi("codex-owner");
    const other = createApi("other-plugin");
    const voice = createApi("voice-call");
    owner.registerAgentHarness({
      id: "codex",
      label: "Codex",
      delegatedExecutionPluginIds: ["voice-call"],
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("unused");
      },
    });
    const runParams = {
      sessionId: reserved.sessionId,
      sessionKey: key.reserved,
      workspaceDir: "/tmp",
      prompt: "continue",
      timeoutMs: 1,
      runId: "run-1",
    } satisfies RunParams;
    const delegated = {
      ...runParams,
      agentId: "main",
      ...lock,
      agentHarnessRuntimeOverride: "codex",
      sessionTarget: {
        agentId: "main",
        sessionId: reserved.sessionId,
        sessionKey: key.reserved,
        storePath: "/tmp/sessions.json",
      },
    };
    const run = (api: typeof owner, params: Partial<RunParams> = {}) =>
      api.runtime.agent.runEmbeddedAgent({ ...runParams, ...params });
    const patch = (
      api: typeof owner,
      sessionKey: string,
      value: Partial<SessionEntry> = { archivedAt: undefined },
    ) => api.runtime.agent.session.patchSessionEntry({ sessionKey, update: () => value });
    const ok = (pending: Promise<unknown>) => expect(pending).resolves.toEqual({ ok: true });
    const rejectedByOwner = (pending: Promise<unknown>) =>
      expect(pending).rejects.toThrow('owned by plugin "codex-owner"');
    const gatewayAgent = (api: typeof owner, identity: Record<string, string>) =>
      api.runtime.gateway.request("agent", { ...identity, message: "continue" });
    const admission = { storePath: "/tmp/sessions.json", sessionKey: key.reserved };
    await expect(patch(owner, key.reserved)).resolves.toMatchObject(reserved);
    await ok(run(owner));
    await ok(gatewayAgent(owner, { sessionKey: key.reserved }));

    let delegatedCallbackScope = getPluginRuntimeGatewayRequestScope();
    await expect(
      voice.runtime.agent.session.runWithWorkAdmission(admission, async () => {
        delegatedCallbackScope = getPluginRuntimeGatewayRequestScope();
        return "admitted";
      }),
    ).resolves.toBe("admitted");
    expect(admissionScope).toMatchObject({ pluginId: "codex-owner" });
    expect(delegatedCallbackScope).toMatchObject({ pluginId: "voice-call" });
    await ok(run(voice, delegated));
    expect(embeddedRunScope).toMatchObject({ pluginId: "codex-owner" });
    for (const invalid of [
      { agentHarnessRuntimeOverride: "openclaw" },
      { agentHarnessId: undefined },
      { agentHarnessRuntimeOverride: undefined },
    ]) {
      await expect(run(voice, { ...delegated, ...invalid })).rejects.toThrow(
        "only with its exact persisted identity and harness",
      );
    }
    await rejectedByOwner(patch(voice, key.reserved, { label: "must stay owner-only" }));
    await rejectedByOwner(patch(other, key.reserved));
    for (const params of [
      {},
      { sessionKey: undefined },
      { sessionId: undefined, sessionKey: undefined, sessionFile: reserved.sessionFile },
      { sessionId: undefined, sessionKey: undefined, sessionFile: key.alias },
      {
        sessionId: ordinary.sessionId,
        sessionKey: key.ordinary,
        sessionFile: reserved.sessionFile,
      },
    ]) {
      await rejectedByOwner(run(other, params));
    }
    await ok(run(other, { sessionId: undefined, sessionKey: undefined, sessionFile: key.noId }));
    await expect(
      run(other, {
        agentId: "main",
        sessionId: ordinary.sessionId,
        sessionKey: key.ordinary,
        sessionFile: reserved.sessionFile,
        sessionTarget: {
          agentId: "main",
          sessionId: ordinary.sessionId,
          sessionKey: key.ordinary,
          storePath: "/tmp/unrelated-sessions.json",
        },
      }),
    ).rejects.toThrow("only with its exact session target identity");
    await rejectedByOwner(
      other.runtime.subagent.run({ sessionKey: key.reserved, message: "continue" }),
    );
    await rejectedByOwner(other.runtime.subagent.deleteSession({ sessionKey: key.reserved }));
    await rejectedByOwner(
      other.runtime.gateway.request("sessions.patch", {
        key: key.reserved,
        archived: true,
        expectedSessionId: reserved.sessionId,
      }),
    );
    const gatewayRequestCountBeforeBatch = gatewayRequest.mock.calls.length;
    await rejectedByOwner(
      other.runtime.gateway.request("sessions.patchMany", {
        targets: [
          { key: key.ordinary, expectedSessionId: ordinary.sessionId },
          { key: key.reserved, expectedSessionId: reserved.sessionId },
        ],
        patch: { archived: true },
      }),
    );
    expect(gatewayRequest).toHaveBeenCalledTimes(gatewayRequestCountBeforeBatch);
    await rejectedByOwner(gatewayAgent(other, { sessionId: reserved.sessionId }));
    await rejectedByOwner(patch(other, key.locked));
    await rejectedByOwner(run(other, { sessionId: locked.sessionId, sessionKey: key.locked }));
    await rejectedByOwner(gatewayAgent(other, { sessionKey: key.locked }));

    await expect(patch(other, key.plugin, { label: "same plugin owner" })).resolves.toMatchObject({
      ...plugin,
      label: "same plugin owner",
    });
    const pluginRun = { sessionId: plugin.sessionId, sessionKey: key.plugin };
    await ok(run(other, pluginRun));
    await expect(run(owner, pluginRun)).rejects.toThrow('owned by plugin "other-plugin"');
    await expect(gatewayAgent(owner, { sessionKey: key.plugin })).rejects.toThrow(
      'owned by plugin "other-plugin"',
    );
    for (const api of [owner, other]) {
      await expect(patch(api, key.mixed, { label: "must not mutate" })).rejects.toThrow(
        "mixes plugin and reserved harness ownership",
      );
    }
    const ordinaryLabel = { label: "still ordinary" };
    await expect(patch(other, key.legacy, ordinaryLabel)).resolves.toMatchObject({
      ...legacy,
      ...ordinaryLabel,
    });
    await expect(patch(other, key.legacy, lock)).rejects.toThrow(
      "does not match its reserved session key",
    );
    const otherSession = other.runtime.agent.session;
    await rejectedByOwner(
      otherSession.upsertSessionEntry({
        sessionKey: key.locked,
        entry: { ...plugin, sessionId: locked.sessionId },
      }),
    );
    await expect(
      otherSession.upsertSessionEntry({
        sessionKey: key.legacy,
        entry: { ...legacy, ...ordinaryLabel },
      }),
    ).resolves.toBeUndefined();
    await expect(
      otherSession.upsertSessionEntry({
        sessionKey: key.legacy,
        entry: { ...legacy, ...lock },
      }),
    ).rejects.toThrow("does not match its reserved session key");
    const legacyAdmission = { ...admission, sessionKey: key.legacy };
    await expect(
      otherSession.runWithWorkAdmission(legacyAdmission, async () => "admitted"),
    ).resolves.toBe("admitted");
    const ownershipChangedRun = vi.fn(async () => "must-not-run");
    vi.mocked(session.getSessionEntryAsync)
      .mockImplementationOnce(async () => legacy)
      .mockImplementationOnce(async () => reserved);
    await expect(
      otherSession.runWithWorkAdmission(legacyAdmission, ownershipChangedRun),
    ).rejects.toThrow("does not match its reserved session key");
    expect(ownershipChangedRun).not.toHaveBeenCalled();
    await expect(
      otherSession.updateSessionStoreEntry({
        ...legacyAdmission,
        update: () => ordinaryLabel,
      }),
    ).resolves.toEqual(legacy);
    await ok(run(other, { sessionId: legacy.sessionId, sessionKey: key.legacy }));
    await expect(
      other.runtime.subagent.deleteSession({ sessionKey: key.legacy }),
    ).resolves.toBeUndefined();
    await ok(
      other.runtime.gateway.request("sessions.patch", {
        key: key.legacy,
        archived: true,
        expectedSessionId: legacy.sessionId,
      }),
    );
    await ok(run(other, { sessionId: ordinary.sessionId, sessionKey: key.ordinary }));
    await ok(other.runtime.gateway.request("voicecall.start", { to: "+15550001234" }));
  });
});
