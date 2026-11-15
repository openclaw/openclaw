import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { createPluginStateKeyedStoreV2ForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { registerTestPlugin } from "openclaw/plugin-sdk/plugin-test-contracts";
import { expect, onTestFinished, test, vi } from "vitest";
import type {
  SessionsCatalogListResult,
  SessionsCatalogReadResult,
} from "../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { loadConfig, writeConfigFile } from "../config/config.js";
import {
  listSessionEntriesCore,
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { loadOpenClawPluginsAsync } from "../plugins/loader.js";
import { projectPluginContributions } from "../plugins/registry-contributions.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission-state.js";
import { listSessionStateEventsSince } from "../sessions/session-state-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { publishConfiguredModelRuntimeSnapshots } from "./server-startup-model-runtime.js";
import {
  BROWSER_ORIGIN,
  CONTROL_UI_CLIENT,
  TRUSTED_BROWSER_HEADERS,
  browserProxyAuth,
  configureBrowserAuth,
  connectReq,
  installGatewayTestHooks,
  openWs,
  rpcReq,
  withGatewayServer,
} from "./server.auth.test-helpers.js";
import { agentCommandMock, agentDiscoveryMock, testState } from "./test-helpers.js";
import { setTestPluginRegistry } from "./test-helpers.plugin-registry.js";

installGatewayTestHooks({ scope: "suite" });

test("HTTP Visitor publications are privately readable by their initial publisher through admitted RPC", async () => {
  const roles = {
    default: "guest",
    definitions: {
      guest: {
        accessPolicyPlugin: "visitor-access",
        sessions: { others: "view" as const },
        agents: "*" as const,
        scopes: ["operator.sessions.write" as const],
      },
      staff: {
        sessions: { others: "write" as const },
        agents: "*" as const,
        scopes: ["operator.admin" as const],
      },
      reader: {
        sessions: { others: "view" as const },
        agents: "*" as const,
        scopes: ["operator.read" as const],
      },
    },
  };
  await configureBrowserAuth(browserProxyAuth(), { roles });
  for (const role of ["staff", "reader"]) {
    setUserProfileRole(ensureProfileForEmail(role + "@example.test").id, role);
  }
  const grants = new Map(
    ["alice", "bob"].map((name) => [name + "@example.test", new AbortController()]),
  );
  const fixture = {
    config: {
      agents: { entries: { main: {} } },
      plugins: { entries: { beam: { enabled: true } } },
    },
    registry: createTestPluginRegistry(createPluginRuntime()),
  };
  registerTestPlugin({
    ...fixture,
    record: createPluginRecord({ id: "visitor-access", origin: "bundled" }),
    register(api) {
      api.registerGatewayAccessPolicy({
        authorize({ requiredByRole, profile }) {
          const grant = grants.get(profile.emails[0] ?? "");
          if (!requiredByRole) {
            return undefined;
          }
          if (!grant) {
            throw new Error("No synthetic Visitor invitation");
          }
          grant.signal.throwIfAborted();
          return {
            grantId: "synthetic-" + profile.profileId,
            signal: grant.signal,
            assertCurrent() {
              grant.signal.throwIfAborted();
            },
          };
        },
      });
    },
  });
  // The real loader captures the operation module source together with its instance.
  // A direct registration fixture has a lifetime, but no admitted operation-code owner.
  const registry = await loadOpenClawPluginsAsync({
    config: fixture.config,
    // The minimal Gateway fixture deliberately disables bundled discovery. Load only
    // Beam from this checkout without changing the Gateway's isolation environment.
    env: {
      ...process.env,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
      OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../../extensions/", import.meta.url)),
    },
    onlyPluginIds: ["beam"],
    preferBuiltPluginArtifacts: false,
    activate: false,
    cache: false,
    throwOnLoadError: true,
  });
  expect(registry.plugins).toContainEqual(
    expect.objectContaining({ id: "beam", status: "loaded" }),
  );
  expect(registry.httpRoutes).toContainEqual(
    expect.objectContaining({ pluginId: "beam", path: "/api/v1/beam/sessions" }),
  );
  for (const record of fixture.registry.registry.plugins) {
    registry.plugins.push(record);
    projectPluginContributions(fixture.registry.registry, record, registry);
  }
  setTestPluginRegistry(registry);
  await withGatewayServer(async ({ port }) => {
    const connect = async (name: string) => {
      const ws = await openWs(port, {
        ...TRUSTED_BROWSER_HEADERS,
        "x-forwarded-user": name + "@example.test",
      });
      expect(
        (
          await connectReq(ws, {
            prePairDevice: true,
            client: CONTROL_UI_CLIENT,
            browserOrigin: BROWSER_ORIGIN,
            skipDefaultAuth: true,
            scopes: ["operator.read", "operator.write", "operator.sessions.write"],
          })
        ).ok,
      ).toBe(true);
      return ws;
    };
    const alice = await connect("alice"),
      bob = await connect("bob"),
      staff = await connect("staff"),
      reader = await connect("reader");
    const profileCatalog = await prepareUserProfileCatalog();
    onTestFinished(profileCatalog.release);
    const ids = ["a".repeat(32), "b".repeat(32), "c".repeat(32), "d".repeat(32)];
    // A retained pre-ownership snapshot is not claimable through matching uploader attribution.
    await createPluginStateKeyedStoreV2ForTests(
      "beam",
      {
        namespace: "sessions",
        maxEntries: 500,
        overflowPolicy: "evict-oldest",
        defaultTtlMs: 7 * 24 * 60 * 60 * 1000,
      },
      { assertCurrent() {} },
    ).register(ids[3]!, {
      version: 1,
      beamId: ids[3],
      title: "Legacy ownerless",
      source: "fixture",
      updatedAt: "2026-11-02T12:00:00Z",
      completed: true,
      createdAt: Date.now(),
      receivedAt: Date.now(),
      uploaderProfileId: ensureProfileForEmail("alice@example.test").id,
      items: [{ type: "userMessage", text: "Private legacy synthetic" }],
    });
    const upload = async (
      name: string,
      id: string,
      headers = {},
      handoffId?: string,
      contentName = name,
    ) =>
      fetch(`http://127.0.0.1:${port}/api/v1/beam/sessions`, {
        method: "POST",
        headers: {
          ...TRUSTED_BROWSER_HEADERS,
          "x-forwarded-user": name + "@example.test",
          "x-openclaw-scopes":
            name === "staff"
              ? "operator.write"
              : name === "reader"
                ? "operator.read"
                : "operator.sessions.write",
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify({
          version: 1,
          beamId: id,
          title: "Synthetic " + contentName,
          source: "fixture",
          updatedAt: "2026-11-02T12:00:00Z",
          completed: true,
          items: [{ type: "userMessage", text: "Private synthetic " + contentName }],
          ...(handoffId ? { handoffId } : {}),
        }),
      });
    try {
      const anonymous = await openWs(port, { origin: BROWSER_ORIGIN });
      try {
        expect(
          (
            await connectReq(anonymous, {
              prePairDevice: true,
              client: CONTROL_UI_CLIENT,
              browserOrigin: BROWSER_ORIGIN,
              skipDefaultAuth: true,
              scopes: ["operator.sessions.write"],
            })
          ).ok,
        ).toBe(false);
      } finally {
        anonymous.close();
      }
      const published = await upload("alice", ids[0]!);
      expect(published.status, await published.clone().text()).toBe(200);
      const publication = await published.json();
      expect(publication).toMatchObject({
        ok: true,
        canView: true,
        url: "/beam/synthetic-alice-aaaaaaaaaaaa",
      });
      expect((await upload("bob", ids[1]!)).status).toBe(200);
      expect((await upload("staff", ids[2]!)).status).toBe(200);
      expect((await upload("reader", ids[0]!)).status).toBe(403);
      expect(
        (await fetch(`http://127.0.0.1:${port}/api/v1/beam/sessions`, { method: "POST" })).status,
      ).toBe(401);
      // This is the original failure: shared catalog admission remains forbidden, not broadened.
      expect(
        await rpcReq(alice, "sessions.catalog.list", { search: "aaaaaaaaaaaa" }),
      ).toMatchObject({ ok: false, error: { message: "missing scope: operator.read" } });
      const own = await rpcReq<SessionsCatalogListResult>(alice, "beam.owned.list", {
        search: "aaaaaaaaaaaa",
        limitPerHost: 2,
      });
      expect(own.ok, JSON.stringify(own.error)).toBe(true);
      expect(own.payload?.catalogs[0]?.hosts[0]?.sessions).toMatchObject([
        {
          threadId: ids[0],
          canContinue: false,
          canArchive: false,
          continuationUnavailableReason: expect.stringContaining("beam handoff"),
          continuationUnavailableReasonCode: "source-handoff-required",
        },
      ]);
      expect(JSON.stringify(own)).not.toContain("publisherProfileId");
      const request = { catalogId: "beam", hostId: "gateway", threadId: ids[0] };
      const page = await rpcReq<SessionsCatalogReadResult>(alice, "beam.owned.read", request);
      expect(page.ok, JSON.stringify(page.error)).toBe(true);
      expect(page.payload?.items).toEqual([
        {
          id: ids[0] + ":0",
          type: "userMessage",
          text: "Private synthetic alice",
          timestamp: "2026-11-02T12:00:00Z",
        },
      ]);
      expect((await upload("staff", ids[0]!)).status).toBe(200);
      const replaced = await rpcReq<SessionsCatalogReadResult>(alice, "beam.owned.read", request);
      expect(replaced.ok).toBe(true);
      expect(replaced.payload?.items[0]?.text).toBe("Private synthetic staff");
      expect(replaced.payload?.items[0]?.sender).toBeUndefined();
      const released = await upload("alice", ids[0]!, {}, publication.publicationId, "staff");
      expect(released.status, await released.clone().text()).toBe(200);
      const continued = await rpcReq<{ sessionKey: string }>(alice, "beam.owned.continue", {
        ...request,
        agentId: "main",
      });
      expect(continued.ok, JSON.stringify(continued.error)).toBe(true);
      const sessionKey = continued.payload!.sessionKey;
      const history = await rpcReq<{ messages: unknown[] }>(alice, "chat.history", { sessionKey });
      expect(history.ok, JSON.stringify(history.error)).toBe(true);
      expect(JSON.stringify(history.payload?.messages)).toContain("Private synthetic staff");
      expect(JSON.stringify(history.payload)).not.toContain(
        ensureProfileForEmail("staff@example.test").id,
      );
      expect(
        (
          await rpcReq(bob, "chat.send", {
            sessionKey,
            message: "Not my continuation",
            idempotencyKey: "synthetic-non-owner-send",
          })
        ).ok,
      ).toBe(false);
      const sent = await rpcReq(alice, "chat.send", {
        sessionKey,
        message: "Continue my published conversation",
        idempotencyKey: "synthetic-publisher-first-send",
      });
      expect(sent.ok, JSON.stringify(sent.error)).toBe(true);
      expect((await rpcReq(alice, "beam.owned.read", request)).payload).toEqual(replaced.payload);
      expect(
        (
          await rpcReq(alice, "beam.owned.continue", {
            ...request,
            sourceHomeId: "not-a-home-grant",
          })
        ).ok,
      ).toBe(false);
      for (const [ws, id] of [
        [bob, ids[0]],
        [alice, ids[1]],
        [alice, ids[2]],
        [alice, ids[3]],
        [reader, ids[0]],
      ] as const) {
        const denied = await rpcReq(ws, "beam.owned.read", { ...request, threadId: id });
        expect(denied.ok).toBe(false);
        if (ws !== reader) {
          expect(denied.error?.code).toBe("FORBIDDEN");
        }
        expect(JSON.stringify(denied)).not.toContain("Private");
        const deniedContinue = await rpcReq(ws, "beam.owned.continue", {
          ...request,
          threadId: id,
        });
        expect(deniedContinue.ok).toBe(false);
        expect(JSON.stringify(deniedContinue)).not.toContain("Private");
      }
      expect(
        (await rpcReq<SessionsCatalogListResult>(alice, "beam.owned.list", {})).payload?.catalogs[0]
          ?.hosts[0]?.sessions,
      ).toHaveLength(1);
      expect((await rpcReq(staff, "sessions.catalog.read", request)).ok).toBe(true);
      expect((await rpcReq(alice, "sessions.catalog.archive", request)).ok).toBe(false);
      const revokedConnection = new Promise<number>((resolve) => {
        alice.once("close", resolve);
      });
      grants.get("alice@example.test")!.abort(new Error("synthetic invitation expired or revoked"));
      expect(await revokedConnection).toBe(4001);
      expect(
        (
          await rpcReq(staff, "sessions.catalog.archive", {
            ...request,
            confirmNoOtherRunner: true,
          })
        ).ok,
      ).toBe(true);
    } finally {
      for (const ws of [alice, bob, staff, reader]) {
        ws.close();
      }
    }
  });
});

test("preserves model admission and rolls back revoked owned Beam adoption", async ({ signal }) => {
  const modelA = "fixture/fixture-model-a";
  const modelB = "fixture/fixture-model-b";
  const models = ["a", "b"].map((id) => ({
    id: "fixture-model-" + id,
    name: "Fixture Model " + id,
    api: "openai-completions" as const,
    baseUrl: "http://127.0.0.1:1/v1",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  }));
  // Dependency catalog DATA only: the maintained availability and role owners still run.
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = models.map((model) => ({ provider: "fixture", ...model }));
  testState.agentConfig = { model: { primary: modelB }, models: { [modelA]: {}, [modelB]: {} } };
  const role = "beam-model-publisher";
  await configureBrowserAuth(browserProxyAuth(), {
    roles: {
      default: role,
      definitions: {
        [role]: {
          accessPolicyPlugin: "visitor-access",
          sessions: { others: "view" },
          agents: ["main"],
          scopes: ["operator.sessions.write"],
          modelPolicy: { allow: [modelA] },
        },
        administrator: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
        blocked: { sessions: { others: "none" }, agents: "*", scopes: [] },
      },
    },
  });
  await writeConfigFile({
    ...loadConfig(),
    models: {
      providers: {
        fixture: {
          api: "openai-completions",
          apiKey: "test-fixture-key",
          baseUrl: "http://127.0.0.1:1/v1",
          models,
        },
      },
    },
  });
  const publisher = ensureProfileForEmail("model-publisher@example.test");
  setUserProfileRole(publisher.id, role);
  setUserProfileRole(ensureProfileForEmail("beam-administrator@example.test").id, "administrator");
  const grant = new AbortController();
  const config = {
    agents: { entries: { main: {} } },
    plugins: { entries: { beam: { enabled: true } } },
  };
  const access = createTestPluginRegistry(createPluginRuntime());
  registerTestPlugin({
    config,
    registry: access,
    record: createPluginRecord({ id: "visitor-access", origin: "bundled" }),
    register(api) {
      api.registerGatewayAccessPolicy({
        authorize({ requiredByRole, profile }) {
          if (!requiredByRole) {
            return undefined;
          }
          expect(profile.profileId).toBe(publisher.id);
          grant.signal.throwIfAborted();
          return {
            grantId: "synthetic-model-publisher",
            signal: grant.signal,
            assertCurrent() {
              grant.signal.throwIfAborted();
            },
          };
        },
      });
    },
  });
  const registry = await loadOpenClawPluginsAsync({
    config,
    env: {
      ...process.env,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
      OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../../extensions/", import.meta.url)),
    },
    onlyPluginIds: ["beam"],
    preferBuiltPluginArtifacts: false,
    activate: false,
    cache: false,
    throwOnLoadError: true,
  });
  for (const record of access.registry.plugins) {
    registry.plugins.push(record);
    projectPluginContributions(access.registry, record, registry);
  }
  setTestPluginRegistry(registry);
  // Observe, without replacing, the real availability projection used by adoption.
  const assessment = vi.spyOn(
    await import("./server-methods/models-list-result.js"),
    "buildModelsListResult",
  );
  onTestFinished(() => assessment.mockRestore());
  await withGatewayServer(async ({ port }) => {
    const origin = "http://127.0.0.1:" + port;
    const realFetch = globalThis.fetch;
    const fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const target = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (target.origin !== origin) {
        throw new Error("Provider requests are forbidden in this metadata-only proof");
      }
      return realFetch(input, init);
    });
    onTestFinished(() => fetchGuard.mockRestore());
    const connect = async (email: string, scopes: string[]) => {
      const socket = await openWs(port, { ...TRUSTED_BROWSER_HEADERS, "x-forwarded-user": email });
      expect(
        (
          await connectReq(socket, {
            prePairDevice: true,
            client: CONTROL_UI_CLIENT,
            browserOrigin: BROWSER_ORIGIN,
            skipDefaultAuth: true,
            scopes,
          })
        ).ok,
      ).toBe(true);
      return socket;
    };
    let ws = await connect("model-publisher@example.test", ["operator.sessions.write"]);
    const admin = await connect("beam-administrator@example.test", ["operator.admin"]);
    try {
      const profiles = await prepareUserProfileCatalog();
      onTestFinished(profiles.release);
      await publishConfiguredModelRuntimeSnapshots({ cfg: loadConfig() });
      const ordinary = await rpcReq<{
        key: string;
        entry: { providerOverride?: string; modelOverride?: string };
      }>(ws, "sessions.create", {
        key: "agent:main:beam-role-allowed",
        agentId: "main",
        model: modelA,
      });
      expect(ordinary.ok, JSON.stringify(ordinary.error)).toBe(true);
      expect(ordinary.payload?.entry).toMatchObject({
        providerOverride: "fixture",
        modelOverride: "fixture-model-a",
      });
      const denied = await rpcReq(ws, "sessions.create", {
        key: "agent:main:beam-role-disallowed",
        agentId: "main",
        model: modelB,
      });
      expect(denied).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      const releaseBeam = async (beamId: string, model: string) => {
        const payload = {
          version: 1,
          beamId,
          title: "Synthetic named-role metadata",
          sourceModel: { provider: "fixture", model: model.split("/")[1] },
          source: "fixture",
          updatedAt: "2026-11-04T00:00:00Z",
          completed: true,
          items: [{ type: "userMessage", text: "Synthetic imported context " + beamId }],
        };
        const upload = (body: unknown) =>
          fetch(origin + "/api/v1/beam/sessions", {
            method: "POST",
            headers: {
              ...TRUSTED_BROWSER_HEADERS,
              "x-forwarded-user": "model-publisher@example.test",
              "x-openclaw-scopes": "operator.sessions.write",
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          });
        const published = await upload(payload);
        expect(published.status, await published.clone().text()).toBe(200);
        const { publicationId } = await published.json();
        expect(publicationId).toMatch(/^[a-f0-9]{32}$/);
        const released = await upload({ ...payload, handoffId: publicationId });
        expect(released.status, await released.clone().text()).toBe(200);
        return { catalogId: "beam", hostId: "gateway", threadId: beamId, agentId: "main" };
      };
      const keys = () =>
        listSessionEntriesCore({ agentId: "main" })
          .map(({ sessionKey }) => sessionKey)
          .toSorted();
      const allowed = await releaseBeam("8".repeat(32), modelA);
      const adopted = await rpcReq<{ sessionKey: string }>(ws, "beam.owned.continue", allowed);
      expect(adopted.ok, JSON.stringify(adopted.error)).toBe(true);
      const allowedKey = expectDefined(adopted.payload, "adopted destination").sessionKey;
      const allowedEntry = expectDefined(
        loadSessionEntryReadOnly({ agentId: "main", sessionKey: allowedKey }),
        "persisted destination",
      );
      expect(allowedEntry).toMatchObject({
        providerOverride: "fixture",
        modelOverride: "fixture-model-a",
      });
      expect(allowedEntry.initializationPending).toBeUndefined();
      expect(allowedEntry.pluginExtensions?.beam).toMatchObject({
        catalogContinuation: { catalogId: "beam", threadId: allowed.threadId },
      });
      const allowedScope = {
        agentId: "main",
        sessionKey: allowedKey,
        sessionId: allowedEntry.sessionId,
      };
      const imported = await loadTranscriptEvents(allowedScope);
      const importedText = JSON.stringify(imported);
      expect(importedText.split("Synthetic imported context " + allowed.threadId)).toHaveLength(2);
      expect(importedText).toContain("EXTERNAL_UNTRUSTED_CONTENT");
      expect(
        (await listSessionStateEventsSince(allowedKey, "main", 0)).events.filter(
          ({ kind }) => kind === "adopted",
        ),
      ).toHaveLength(1);
      expect((await rpcReq(ws, "beam.owned.resolve", allowed)).payload).toEqual({
        sessionKey: allowedKey,
      });
      expect((await rpcReq(ws, "beam.owned.continue", allowed)).payload).toEqual({
        sessionKey: allowedKey,
      });
      expect(await loadTranscriptEvents(allowedScope)).toEqual(imported);
      const beforeDenied = keys();
      const forbidden = await releaseBeam("9".repeat(32), modelB);
      const continued = await rpcReq(ws, "beam.owned.continue", forbidden);
      const projected = await assessment.mock.results.at(-1)?.value;
      expect(projected?.models).toContainEqual(
        expect.objectContaining({ provider: "fixture", id: "fixture-model-b", available: true }),
      );
      expect(continued).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      expect(continued.error?.message).toMatch(/role.*model|model.*role/i);
      expect(keys()).toEqual(beforeDenied);

      const request = await releaseBeam("7".repeat(32), modelA);
      const historyImport = await import("../plugins/session-catalog-history-import.js");
      const realImport = historyImport.importSessionCatalogHistory;
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const exited = createDeferredCore();
      let scope: { agentId: string; sessionKey: string; sessionId: string } | undefined;
      const barrier = vi
        .spyOn(historyImport, "importSessionCatalogHistory")
        .mockImplementation(async (params) => {
          const result = await realImport(params);
          scope = {
            agentId: expectDefined(params.agentId, "import owner"),
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
          };
          entered.resolve();
          try {
            await resume.promise;
          } finally {
            exited.resolve();
          }
          return result;
        });
      onTestFinished(() => barrier.mockRestore());
      const pending = rpcReq(ws, "beam.owned.continue", request).then(
        (reply) => ({ reply }),
        (error: unknown) => ({ error }),
      );
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            entered.promise,
            pending,
            "adoption settled before real history import",
          ),
          signal,
        );
        const inflight = expectDefined(scope, "pending destination scope");
        expect(loadSessionEntryReadOnly(inflight)?.initializationPending).toBe(true);
        expect(JSON.stringify(await loadTranscriptEvents(inflight))).toContain(
          "Synthetic imported context " + request.threadId,
        );
        const closed = new Promise<number>((resolve) => {
          ws.once("close", resolve);
        });
        expect(
          (await rpcReq(admin, "users.setRole", { profileId: publisher.id, role: "blocked" })).ok,
        ).toBe(true);
        expect(await withinTest(closed, signal)).toBe(4001);
        resume.resolve();
        await withinTest(exited.promise, signal);
        const settled = await withinTest(pending, signal);
        if ("reply" in settled) {
          expect(settled.reply.ok).toBe(false);
        } else {
          expect(String(settled.error)).toMatch(/closed|4001/);
        }
        await expect.poll(() => getActiveGatewayRootWorkCount(), { timeout: 5000 }).toBe(0);
        expect(keys()).toEqual(beforeDenied);
        expect(loadSessionEntryReadOnly(inflight)).toBeUndefined();
        expect(await loadTranscriptEvents(inflight)).toEqual([]);
        expect(
          (await listSessionStateEventsSince(inflight.sessionKey, "main", 0)).events.filter(
            ({ kind }) => kind === "adopted",
          ),
        ).toEqual([]);
        expect(await loadTranscriptEvents(allowedScope)).toEqual(imported);
        barrier.mockRestore();
        expect((await rpcReq(admin, "users.setRole", { profileId: publisher.id, role })).ok).toBe(
          true,
        );
        ws = await connect("model-publisher@example.test", ["operator.sessions.write"]);
        const retry = await rpcReq<{ sessionKey: string }>(ws, "beam.owned.continue", request);
        expect(retry.ok, JSON.stringify(retry.error)).toBe(true);
        expect(retry.payload?.sessionKey).toBe(inflight.sessionKey);
        expect(loadSessionEntryReadOnly(inflight)?.initializationPending).toBeUndefined();
        expect(
          (await listSessionStateEventsSince(inflight.sessionKey, "main", 0)).events.filter(
            ({ kind }) => kind === "adopted",
          ),
        ).toHaveLength(1);
      } finally {
        resume.resolve();
        ws.close();
        await pending;
        barrier.mockRestore();
      }
      expect(agentCommandMock).not.toHaveBeenCalled();
    } finally {
      ws.close();
      admin.close();
    }
  });
});
