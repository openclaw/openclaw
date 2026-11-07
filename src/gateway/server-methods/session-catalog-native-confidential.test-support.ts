import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import {
  capturePiCatalog,
  piJsonl,
  piMessage,
  piSessionHeader,
  usePiFixtures,
} from "../../../extensions/acpx/src/pi-session-catalog.test-support.js";
import type { SessionCatalogHost } from "../../../packages/gateway-protocol/src/index.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  upsertSessionEntryCore,
  loadSessionEntryReadOnly,
} from "../../config/sessions/session-accessor.js";
import { applySessionEntryCanonicalReplacements } from "../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  withOpenClawTestState,
  type createOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { resolveSessionCatalogVisibility } from "./session-catalog-visibility.js";
import { sessionCatalogHandlers } from "./session-catalog.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const nativePiFixtures = usePiFixtures();
type PiConfidentialFixture = Awaited<ReturnType<typeof createConfidentialPiCatalog>>;
export async function withConfidentialPi(
  run: (fixture: PiConfidentialFixture) => Promise<void>,
  solo = false,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const previous = getActivePluginRegistry() ?? createEmptyPluginRegistry();
    const fixture = await createConfidentialPiCatalog(solo, state);
    try {
      await run(fixture);
    } finally {
      fixture.projection.dispose();
      setActivePluginRegistry(previous);
    }
  });
}
async function createConfidentialPiCatalog(
  solo: boolean,
  state: Awaited<ReturnType<typeof createOpenClawTestState>>,
) {
  const bob = ensureProfileForEmail("native-bob@example.test");
  const alice = solo
    ? { id: "00000000-0000-4000-8000-000000000001" }
    : ensureProfileForEmail("native-alice@example.test");
  const eve = solo ? bob : ensureProfileForEmail("native-eve@example.test");
  const admin = solo ? bob : ensureProfileForEmail("native-admin@example.test");
  if (!solo) {
    setUserProfileRole(admin.id, "administrator");
  }
  const cfg: OpenClawConfig = {
    gateway: {
      roles: {
        default: "reader",
        definitions: {
          reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
          administrator: { agents: "*", scopes: ["operator.admin"], sessions: { others: "write" } },
        },
      },
    },
    session: {
      sharing: {
        accessPolicy: {
          default: "creator",
          groups: [
            {
              channel: "telegram",
              agentId: "main",
              peerId: "-100123",
              profileIds: [bob.id],
            },
          ],
        },
      },
    },
  };
  if (solo) {
    delete cfg.gateway;
  }
  setRuntimeConfigSnapshot(cfg);
  const directory = await nativePiFixtures.createStore("PRIVATE_NATIVE_unbound");
  const keys = {
    private: "agent:main:plugin:acpx:catalog-adopt:pi:private",
    legacy: "agent:main:plugin:acpx:catalog-adopt:pi:legacy",
    audience: "agent:main:plugin:acpx:catalog-adopt:pi:audience",
    source: "agent:main:telegram:group:-100123",
  };
  for (const [id, sessionKey] of Object.entries(keys)) {
    await fs.writeFile(
      path.join(directory, id + ".jsonl"),
      piJsonl([
        piSessionHeader({ id }),
        piMessage(
          { role: "assistant", content: [{ type: "text", text: "PRIVATE_NATIVE_" + id }] },
          { id: "answer-" + id, parentId: null },
        ),
      ]),
    );
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: "adopted-" + id,
        updatedAt: 1,
        visibility: "shared",
        pluginOwnerId: "acpx",
        createdVia: "operator",
        createdActor: { type: "human", source: "profile", id: alice.id },
        pluginExtensions: { acpx: { piSessionCatalog: { sourceThreadId: id } } },
        ...(id === "legacy"
          ? {}
          : {
              access:
                id === "source"
                  ? { mode: "source" as const }
                  : id === "audience"
                    ? { mode: "audience" as const, profileIds: [bob.id] }
                    : { mode: "creator" as const },
            }),
      },
    );
  }
  const runtime = createPluginRuntime();
  const { provider } = capturePiCatalog(
    {
      config: runtime.config,
      agent: runtime.agent,
      nodes: { list: async () => ({ nodes: [] }) },
    },
    { id: "acpx", config: cfg },
  );
  const registry = createEmptyPluginRegistry();
  registry.sessionCatalogs.push({ pluginId: "acpx", source: import.meta.url, provider });
  setActivePluginRegistry(registry);
  const projection = await createSessionRowProjection({ cfg, getConfig: () => cfg });
  const client = (id: string, asAdmin = false) =>
    ({
      connId: id,
      connect: { scopes: asAdmin ? ["operator.admin"] : ["operator.read"] },
      authenticatedUserProfile: { profileId: id },
    }) as GatewayClient;
  const clients = {
    alice: client(solo ? bob.id : alice.id),
    bob: client(bob.id),
    eve: client(eve.id),
    admin: client(admin.id, !solo),
  };
  const context = bindSessionRowProjection(
    {
      getRuntimeConfig: () => cfg,
      broadcastToConnIds: vi.fn(),
    },
    () => projection,
  );
  let importContext: GatewayRequestContext | undefined;
  let readImportedTranscript: (() => Promise<unknown[]>) | undefined;
  const call = async (
    method: "list" | "resolve" | "read" | "import",
    id = "private",
    who = clients.bob,
  ) => {
    const respond = vi.fn();
    await withPluginRuntimeGatewayRequestScope(
      {
        client: who,
        pluginRegistry: registry,
        isWebchatConnect: () => false,
      },
      () =>
        sessionCatalogHandlers["sessions.catalog." + method]?.({
          params:
            method === "list"
              ? { catalogId: "pi" }
              : {
                  catalogId: "pi",
                  hostId: "gateway",
                  threadId: id,
                  ...(method === "import" ? { agentId: "main" } : {}),
                },
          client: who,
          context: method === "import" ? importContext : context,
          respond,
        } as never),
    );
    const [ok, payload, error] = respond.mock.calls[0] ?? [];
    const trace = process.env.OPENCLAW_TEST_NATIVE_CATALOG_TRACE_PATH;
    if (trace) {
      const stored = method === "import" ? await readImportedTranscript?.() : undefined;
      await fs.appendFile(
        trace,
        JSON.stringify({
          UTC: new Date().toISOString(),
          method,
          thread: id,
          caller: Object.entries(clients).find(([, value]) => value === who)?.[0],
          ok: ok === true,
          errorCode: error?.code ?? null,
          nativeTextReturned: JSON.stringify(payload ?? null).includes("PRIVATE_NATIVE_"),
          itemCount: payload?.items?.length ?? 0,
          importedItems: payload?.importedItems ?? null,
          canonicalTranscriptItems: stored?.length ?? null,
          privateNativeTextStored: stored
            ? JSON.stringify(stored).includes("PRIVATE_NATIVE_")
            : null,
          listedThreads:
            payload?.catalogs?.[0]?.hosts?.flatMap((host: SessionCatalogHost) =>
              host.sessions.map((entry) => entry.threadId),
            ) ?? [],
        }) + "\n",
      );
    }
    return { ok, payload, error };
  };
  const mutateAccess = async (access: NonNullable<SessionEntry["access"]>, replace = false) => {
    const sessionKey = keys.audience;
    await applySessionEntryCanonicalReplacements({
      agentId: "main",
      sessionKeys: [sessionKey],
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      skipMaintenance: true,
      update: (entries) => {
        const entry = entries.find((row) => row.sessionKey === sessionKey)?.entry;
        expect(entry).toBeDefined();
        return {
          result: null,
          replacements: [
            {
              sessionKey,
              previousSessionKeys: [],
              accessMutation: true,
              entry: {
                ...entry!,
                access,
                ...(replace
                  ? {
                      sessionId: "replaced-native-audience",
                      lifecycleRevision: "replaced-native-lifecycle",
                    }
                  : {}),
              },
            },
          ],
        };
      },
    });
    expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey })?.access).toEqual(access);
  };
  const mutateVisibility = async (thread: "legacy" | "audience") => {
    const scope = { agentId: "main", sessionKey: keys[thread] };
    await upsertSessionEntryCore(scope, { visibility: "draft" });
    const current = loadSessionEntryReadOnly(scope);
    expect(current?.visibility).toBe("draft");
    expect(current?.access).toEqual(
      thread === "legacy" ? undefined : { mode: "audience", profileIds: [bob.id] },
    );
  };
  const adoptUnbound = async () => {
    const sessionKey = "agent:main:plugin:acpx:catalog-adopt:pi:pi-session";
    expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey })).toBeFalsy();
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: "late-adopted-native",
        updatedAt: 2,
        visibility: "shared",
        pluginOwnerId: "acpx",
        createdVia: "operator",
        createdActor: { type: "human", source: "profile", id: bob.id },
        access: { mode: "creator" },
        pluginExtensions: { acpx: { piSessionCatalog: { sourceThreadId: "pi-session" } } },
      },
    );
    expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey })?.access).toEqual({
      mode: "creator",
    });
  };
  const prepareImport = async (threadId = "pi-session", who = clients.bob) => {
    const { prepareNativeCatalogImport } =
      await import("./session-catalog-native-import.test-support.js");
    const prepared = await prepareNativeCatalogImport({
      cfg,
      state,
      projection,
      client: who,
      threadId,
    });
    importContext = prepared.context;
    readImportedTranscript = prepared.transcript;
    return { ...prepared, run: () => call("import", threadId, who) };
  };
  return {
    prepareImport,
    call,
    provider,
    cfg,
    keys,
    clients,
    projection,
    mutateAccess,
    adoptUnbound,
    mutateVisibility,
    visibility: () => resolveSessionCatalogVisibility(clients.bob, cfg),
  };
}
