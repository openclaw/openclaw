import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { revokePluginRecord } from "./registry-lifecycle.js";
import {
  createOwnershipHarness,
  createOwnershipRegistry,
  createOwnershipSubagent,
} from "./registry-ownership.test-support.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { PluginRuntime } from "./runtime/types.js";

type RunParams = Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0];
const runDefaults = { workspaceDir: "/tmp", prompt: "continue", timeoutMs: 1, runId: "run-1" };
const reject = (pending: Promise<unknown>, error: string) => expect(pending).rejects.toThrow(error);
const match = (pending: Promise<unknown>, expected: object) =>
  expect(pending).resolves.toMatchObject(expected);
const admitted = (pending: Promise<unknown>) => expect(pending).resolves.toBe("admitted");

function pluginFixture(runtime: PluginRuntime, id: string, config: OpenClawConfig = {}) {
  const { builder: registry, createApi } = createOwnershipRegistry(runtime, config);
  return { registry, ...createApi(id) };
}

function createApis(runtime: PluginRuntime, config: OpenClawConfig = {}) {
  const { createApi } = createOwnershipRegistry(runtime, config);
  return (id: string) => createApi(id).api;
}

function sessionEntry(sessionId: string, fields: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId, updatedAt: 1, ...fields };
}

describe("plugin registry runtime session ownership", () => {
  it.each(["upsert", "route"] as const)(
    "refuses a prepared %s when its plugin retires before worker admission",
    async (operation) => {
      const runtime = createPluginRuntime();
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const original = sessionEntry("managed", { label: "original" });
      const delivery = normalizeSessionDeliveryState({
        context: { channel: "slack", to: "C123" },
      });
      const waitForAdmission = async () => {
        entered.resolve();
        await resume.promise;
      };
      let stored: SessionEntry = original;
      runtime.agent.session.getSessionEntryAsync = async () => stored;
      runtime.agent.session.upsertSessionEntry = async ({ entry }) => {
        await waitForAdmission();
        stored = entry;
      };
      runtime.agent.session.prepareSessionEntryPatch = async (params) => {
        const patch = await params.prepare(stored, { existingEntry: stored });
        await waitForAdmission();
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
      const applyRoute = () => (stored = { ...stored, delivery });
      runtime.channel.session.updateLastRoute = async () => {
        await waitForAdmission();
        return applyRoute();
      };
      runtime.channel.session.updateLastRouteWithAuthority = async ({ authority }) => {
        await waitForAdmission();
        if (authority.kind === "host") {
          authority.assertCurrent();
        } else {
          authority.source();
        }
        return applyRoute();
      };
      const { registry, record, api } = pluginFixture(runtime, "managed-writer");
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
      const pending = createDeferredCore<SessionEntry>();
      const entry = sessionEntry("managed");
      runtime.agent.session.getSessionEntryAsync = () => pending.promise;
      runtime.agent.session.getSessionEntryByIdAsync = async () => ({
        sessionKey: "agent:main:managed",
        entry: await pending.promise,
      });
      const { registry, record, api } = pluginFixture(runtime, "managed-reader");
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
      const entries = [{ sessionKey: "agent:main:shared", entry: sessionEntry("shared") }];
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
      const { registry, record, api } = pluginFixture(runtime, "session-share");
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
    const entry = sessionEntry("voice-session", {
      pluginOwnerId: "voice-call",
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      modelProvider: "anthropic",
      model: "previous-model",
    });
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
    const identity = { sessionId: entry.sessionId, sessionKey, agentId: "worker" };
    const runParams = {
      ...runDefaults,
      ...identity,
      runId: "voice-run",
      sessionTarget: { ...identity, storePath: "/tmp/sessions.json" },
    } satisfies RunParams;
    const cases: [string, string | undefined, Partial<RunParams>, string?][] = [
      ["stored request", "openclaw", {}, "openclaw"],
      ["agent default provider", "codex", {}, "codex"],
      [
        "request config provider",
        "codex",
        { config: { agents: { defaults: { model: "anthropic/request-model" } } } },
      ],
      ["incompatible provider", "codex", { provider: "anthropic" }],
      ["model-ref provider", "codex", { model: "anthropic/other" }],
      ["explicit runtime", "codex", { agentHarnessRuntimeOverride: "openclaw" }, "openclaw"],
      ["explicit auto", "codex", { agentHarnessRuntimeOverride: "auto" }, "auto"],
      ["detached", "codex", { sessionPersistence: "detached" }],
      ["raw model", "codex", { modelRun: true }],
      ["observation only", undefined, {}],
    ];
    for (const [name, storedRuntime, request, expected] of cases) {
      entry.agentRuntimeOverride = storedRuntime;
      await api.runtime.agent.runEmbeddedAgent({ ...runParams, ...request });
      const forwarded = runEmbeddedAgent.mock.calls.at(-1)?.[0];
      expect(forwarded?.agentHarnessId, name).toBeUndefined();
      expect(forwarded?.agentHarnessRuntimeOverride, name).toBe(expected);
      expect(executionScope?.pluginId, name).toBe("voice-call");
    }
    await expect(otherApi.runtime.agent.runEmbeddedAgent(runParams)).rejects.toThrow(
      'owned by plugin "voice-call"',
    );
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(cases.length);
  });

  it("limits locked harness session mutation and execution to the harness owner", async () => {
    const cfg: OpenClawConfig = {};
    setRuntimeConfigSnapshot(cfg);
    onTestFinished(clearRuntimeConfigSnapshot);
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
    const reserved = sessionEntry("reserved-session", {
      ...lock,
      sessionFile: formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId: "reserved-session",
        storePath: "/tmp/sessions.json",
      }),
    });
    const ordinary = sessionEntry("ordinary-session");
    const locked = sessionEntry("locked-ordinary-session", lock);
    const legacy = sessionEntry("legacy-prefixed-session", { agentHarnessId: "legacy-runtime" });
    const plugin = sessionEntry("plugin-owned-session", { ...lock, pluginOwnerId: "other-plugin" });
    const entries = {
      [key.plugin]: plugin,
      [key.mixed]: { ...plugin, sessionId: "mixed-owner-session" },
      [key.alias]: sessionEntry(reserved.sessionId),
      [key.noId]: { updatedAt: 1 },
      [key.lockedNoId]: { updatedAt: 1, ...lock },
      [key.reserved]: reserved,
      [key.ordinary]: ordinary,
      [key.locked]: locked,
      [key.legacy]: legacy,
    } as unknown as Record<string, SessionEntry>;
    const subagent = createOwnershipSubagent("subagent-run");
    const runtime = createPluginRuntime({ subagent });
    const session = runtime.agent.session;
    session.getSessionEntryAsync = vi.fn(async (params) => entries[params.sessionKey]);
    session.listSessionEntriesAsync = vi.fn(async () =>
      Object.entries(entries).map(([sessionKey, entry]) => ({ sessionKey, entry })),
    );
    const preparePatch: typeof session.prepareSessionEntryPatch = async (params) => {
      const existingEntry = entries[params.sessionKey];
      const entry = existingEntry ?? params.fallbackEntry;
      if (!entry) {
        return null;
      }
      const patch = await params.prepare(structuredClone(entry), {
        existingEntry: existingEntry ? structuredClone(existingEntry) : undefined,
      });
      return patch ? { ...entry, ...patch } : entry;
    };
    session.prepareSessionEntryPatch = vi.fn(preparePatch);
    session.patchSessionEntry = vi.fn((params) =>
      preparePatch({ ...params, prepare: params.update, fallbackEntry: undefined }),
    );
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
    const createApi = createApis(runtime, cfg);
    const owner = createApi("codex-owner");
    const other = createApi("other-plugin");
    const voice = createApi("voice-call");
    owner.registerAgentHarness(
      createOwnershipHarness("codex", {
        label: "Codex",
        delegatedExecutionPluginIds: ["voice-call"],
      }),
    );
    const reservedIdentity = { sessionId: reserved.sessionId, sessionKey: key.reserved };
    const runParams = { ...runDefaults, ...reservedIdentity } satisfies RunParams;
    const sessionStore = { agentId: "main", storePath: "/tmp/sessions.json" };
    const delegated = {
      ...runParams,
      agentId: "main",
      ...lock,
      agentHarnessRuntimeOverride: "codex",
      sessionTarget: { ...sessionStore, ...reservedIdentity },
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
      reject(pending, 'owned by plugin "codex-owner"');
    const gatewayAgent = (api: typeof owner, identity: Record<string, string>) =>
      api.runtime.gateway.request("agent", { ...identity, message: "continue" });
    const gatewayPatch = (sessionKey: string, sessionId: string) =>
      other.runtime.gateway.request("sessions.patch", {
        key: sessionKey,
        archived: true,
        expectedSessionId: sessionId,
      });
    const admission = { storePath: "/tmp/sessions.json", sessionKey: key.reserved };
    await match(patch(owner, key.reserved), reserved);
    await ok(run(owner));
    await ok(gatewayAgent(owner, { sessionKey: key.reserved }));

    let delegatedCallbackScope = getPluginRuntimeGatewayRequestScope();
    await admitted(
      voice.runtime.agent.session.runWithWorkAdmission(admission, async () => {
        delegatedCallbackScope = getPluginRuntimeGatewayRequestScope();
        return "admitted";
      }),
    );
    expect(admissionScope).toMatchObject({ pluginId: "codex-owner" });
    expect(delegatedCallbackScope).toMatchObject({ pluginId: "voice-call" });
    await ok(run(voice, delegated));
    expect(embeddedRunScope).toMatchObject({ pluginId: "codex-owner" });
    const exactHarness = "only with its exact persisted identity and harness";
    for (const invalid of [
      { agentHarnessRuntimeOverride: "openclaw" },
      { agentHarnessId: undefined },
      { agentHarnessRuntimeOverride: undefined },
    ]) {
      await reject(run(voice, { ...delegated, ...invalid }), exactHarness);
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
    const ordinaryIdentity = { sessionId: ordinary.sessionId, sessionKey: key.ordinary };
    const conflictingTarget = {
      agentId: "main",
      ...ordinaryIdentity,
      sessionFile: reserved.sessionFile,
      sessionTarget: {
        ...sessionStore,
        ...ordinaryIdentity,
        storePath: "/tmp/unrelated-sessions.json",
      },
    };
    await reject(run(other, conflictingTarget), "only with its exact session target identity");
    await rejectedByOwner(
      other.runtime.subagent.run({ sessionKey: key.reserved, message: "continue" }),
    );
    await rejectedByOwner(other.runtime.subagent.deleteSession({ sessionKey: key.reserved }));
    await rejectedByOwner(gatewayPatch(key.reserved, reserved.sessionId));
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

    const pluginLabel = { label: "same plugin owner" };
    await match(patch(other, key.plugin, pluginLabel), { ...plugin, ...pluginLabel });
    const pluginRun = { sessionId: plugin.sessionId, sessionKey: key.plugin };
    await ok(run(other, pluginRun));
    await reject(run(owner, pluginRun), 'owned by plugin "other-plugin"');
    await reject(gatewayAgent(owner, { sessionKey: key.plugin }), 'owned by plugin "other-plugin"');
    const mixedOwners = "mixes plugin and reserved harness ownership";
    for (const api of [owner, other]) {
      await reject(patch(api, key.mixed, { label: "must not mutate" }), mixedOwners);
    }
    const ordinaryLabel = { label: "still ordinary" };
    await match(patch(other, key.legacy, ordinaryLabel), { ...legacy, ...ordinaryLabel });
    const wrongReservedKey = (pending: Promise<unknown>) =>
      reject(pending, "does not match its reserved session key");
    await wrongReservedKey(patch(other, key.legacy, lock));
    const otherSession = other.runtime.agent.session;
    const upsert = (sessionKey: string, entry: SessionEntry) =>
      otherSession.upsertSessionEntry({ sessionKey, entry });
    await rejectedByOwner(upsert(key.locked, { ...plugin, sessionId: locked.sessionId }));
    await expect(upsert(key.legacy, { ...legacy, ...ordinaryLabel })).resolves.toBeUndefined();
    await wrongReservedKey(upsert(key.legacy, { ...legacy, ...lock }));
    const legacyAdmission = { ...admission, sessionKey: key.legacy };
    await admitted(otherSession.runWithWorkAdmission(legacyAdmission, async () => "admitted"));
    const ownershipChangedRun = vi.fn(async () => "must-not-run");
    vi.mocked(session.getSessionEntryAsync)
      .mockImplementationOnce(async () => legacy)
      .mockImplementationOnce(async () => reserved);
    await wrongReservedKey(otherSession.runWithWorkAdmission(legacyAdmission, ownershipChangedRun));
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
    await ok(gatewayPatch(key.legacy, legacy.sessionId));
    await ok(run(other, ordinaryIdentity));
    await ok(other.runtime.gateway.request("voicecall.start", { to: "+15550001234" }));
  });
});
