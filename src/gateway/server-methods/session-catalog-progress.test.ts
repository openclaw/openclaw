import { performance } from "node:perf_hooks";
import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContextV2,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { gatewayConnect } from "../server/client-fixtures.test-support.js";
import * as catalogIdentity from "../session-catalog-identity.js";
import { catalogLog } from "./session-catalog-log.test-support.js";
import { catalogProvider as provider } from "./session-catalog.fixtures.test-support.js";
import {
  bindPluginRegistryRuntime,
  call,
  hoisted,
  resetSessionCatalogTestState,
  startCall,
  type PluginRegistry,
  type SessionCatalogProvider,
} from "./session-catalog.test-helpers.js";

const { default: sessionSharePlugin } = await loadBundledPluginFacade<{
  default: { register: (api: OpenClawPluginApi) => void };
}>({ pluginId: "session-share", artifactBasename: "index.js" });

describe("session catalog progress ownership", () => {
  beforeEach(resetSessionCatalogTestState);

  it.each([false, true])(
    "streams hosts only to the requester and honors final withdrawal (withdrawn=%s)",
    async (withdrawn) => {
      const broadcastToConnIds = vi.fn();
      const host = {
        hostId: "node:fast",
        label: "Fast node",
        kind: "node" as const,
        connected: true,
        nodeId: "fast",
        sessions: [],
      };
      hoisted.activeRegistry.sessionCatalogs = [
        {
          provider: provider("codex", {
            list: vi.fn(async ({ onHost }) => {
              onHost?.(host);
              return withdrawn ? [] : [host];
            }),
          }),
        },
      ];

      const respond = await call(
        "sessions.catalog.list",
        { progressId: "progress-1", ...(withdrawn ? { allowPartialResults: true } : {}) },
        {},
        { connId: "requester", connect: gatewayConnect([]) },
        { broadcastToConnIds },
      );

      expect(broadcastToConnIds).toHaveBeenCalledWith(
        "sessions.catalog.host",
        {
          progressId: "progress-1",
          agentId: "main",
          catalog: expect.objectContaining({ id: "codex", hosts: [host] }),
        },
        new Set(["requester"]),
        { dropIfSlow: true },
      );
      expect(broadcastToConnIds).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.[1]?.catalogs[0]?.error).toBeUndefined();
      expect(respond).toHaveBeenCalledWith(true, {
        catalogs: [expect.objectContaining({ id: "codex", hosts: withdrawn ? [] : [host] })],
      });
    },
  );

  it("single-flights identical concurrent lists for one caller and fans progress to active followers", async () => {
    const previousDiagnostics = areDiagnosticsEnabledForProcess();
    setDiagnosticsEnabledForProcess(true);
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const enabled = catalogLog.isEnabled.mockReset().mockReturnValue(true);
    const warn = catalogLog.warn.mockReset().mockImplementation(() => {});
    const { promise: gate, resolve: release } = createDeferredCore();
    const started = createDeferredCore();
    const host = {
      hostId: "gateway:local",
      label: "Local",
      kind: "gateway" as const,
      connected: true,
      sessions: [],
    };
    const late = createDeferredCore();
    const publications: Promise<void>[] = [];
    const list = vi.fn<SessionCatalogProvider["list"]>(async ({ onHost, waitUntil }) => {
      const publication = late.promise.then(() => onHost?.(host));
      publications.push(publication);
      waitUntil?.(publication);
      started.resolve();
      await gate;
      onHost?.(host);
      return [host];
    });
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("codex", { list }) }];
    const config = { agents: { entries: { main: {}, research: {} } } };
    const leaderBroadcast = vi.fn();
    const followerBroadcast = vi.fn();
    const sharedClient = { connId: "requester", connect: gatewayConnect([]) };
    const leader = startCall(
      "sessions.catalog.list",
      { progressId: "leader-progress", agentId: "main" },
      config,
      sharedClient,
      { broadcastToConnIds: leaderBroadcast },
    );
    const follower = startCall(
      "sessions.catalog.list",
      { progressId: "follower-progress", agentId: "main" },
      config,
      sharedClient,
      { broadcastToConnIds: followerBroadcast },
    );
    const otherAgent = startCall("sessions.catalog.list", { agentId: "research" }, config);
    const otherParams = startCall(
      "sessions.catalog.list",
      { search: "other", agentId: "main" },
      config,
    );

    try {
      await started.promise;
      expect(list).toHaveBeenCalledTimes(3);
      clock = 1_500;
      release();
      await Promise.all([
        leader.completion,
        follower.completion,
        otherAgent.completion,
        otherParams.completion,
      ]);

      expect(list).toHaveBeenCalledTimes(3);
      expect(leaderBroadcast).toHaveBeenCalledOnce();
      expect(followerBroadcast).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledTimes(3);
      for (const [message, fields] of warn.mock.calls) {
        expect(message).toBe("slow session catalog provider list");
        expect(fields).toMatchObject({ elapsedMs: 1_500, returnedGatewayHostCount: 1 });
      }
      for (const pending of [leader, follower, otherAgent, otherParams]) {
        expect(pending.respond).toHaveBeenCalledWith(true, {
          catalogs: [expect.objectContaining({ id: "codex", hosts: [host] })],
        });
      }
      const settledBroadcast = vi.fn();
      await call(
        "sessions.catalog.list",
        { progressId: "settled-progress", agentId: "main" },
        config,
        sharedClient,
        { broadcastToConnIds: settledBroadcast },
      );
      clock = 5_000;
      late.resolve();
      await Promise.all(publications);
      expect(leaderBroadcast).toHaveBeenCalledTimes(2);
      expect(followerBroadcast).toHaveBeenCalledTimes(2);
      expect(settledBroadcast).toHaveBeenCalledTimes(2);
      expect(list).toHaveBeenCalledTimes(4);
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      release();
      late.resolve();
      await Promise.allSettled([
        leader.completion,
        follower.completion,
        otherAgent.completion,
        otherParams.completion,
        ...publications,
      ]);
      now.mockRestore();
      enabled.mockReset();
      warn.mockReset();
      setDiagnosticsEnabledForProcess(previousDiagnostics);
    }
  });

  it.each([
    { request: {}, connected: true, partial: false },
    { request: { progressId: "legacy" }, connected: true, partial: false },
    { request: { allowPartialResults: true, progressId: "live" }, connected: true, partial: true },
    {
      request: { allowPartialResults: true, progressId: "live" },
      connected: false,
      partial: false,
    },
    {
      request: { allowPartialResults: true, progressId: "live", hostIds: ["node:fast"] },
      connected: true,
      partial: false,
    },
    {
      request: { allowPartialResults: true, progressId: "live", cursors: { "node:fast": "page" } },
      connected: true,
      partial: false,
    },
  ])(
    "negotiates partial catalog results for $request (connected=$connected)",
    async ({ request, connected, partial }) => {
      const release = createDeferredCore();
      const list = vi.fn<SessionCatalogProvider["list"]>(async () => {
        await release.promise;
        return [];
      });
      hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("fixture", { list }) }];
      const config = {};
      const client = { connId: "requester", connect: gatewayConnect([]) };
      const context = { isConnectionActive: () => connected };
      const progressive = startCall(
        "sessions.catalog.list",
        { catalogId: "fixture", ...request },
        config,
        client,
        context,
      );
      const complete = startCall(
        "sessions.catalog.list",
        { catalogId: "fixture", ...request, allowPartialResults: false },
        config,
        client,
        context,
      );
      try {
        release.resolve();
        await Promise.all([progressive.completion, complete.completion]);
        expect(list).toHaveBeenCalledWith(
          expect.objectContaining({ allowPartialResults: partial }),
        );
        expect(list).toHaveBeenCalledTimes(partial ? 2 : 1);
      } finally {
        release.resolve();
        await Promise.allSettled([progressive.completion, complete.completion]);
      }
    },
  );

  it.each([false, true])(
    "keeps newer host publications in the aggregate while another provider waits (cold=%s)",
    async (cold) => {
      const sibling = createDeferredCore();
      const publish = createDeferredCore();
      const local = {
        hostId: "gateway:local",
        label: "Local",
        kind: "gateway" as const,
        connected: true,
        sessions: [],
      };
      const cached = {
        hostId: "node:slow",
        label: "Cached",
        kind: "node" as const,
        connected: true,
        sessions: [],
      };
      const fresh = { ...cached, label: "Fresh" };
      let publication: Promise<void> | undefined;
      hoisted.activeRegistry.sessionCatalogs = [
        {
          provider: provider("fixture", {
            list: async ({ onHost, waitUntil }) => {
              publication = publish.promise.then(() => onHost?.(fresh));
              waitUntil?.(publication);
              return cold ? [local, { ...cached, pending: true }] : [local, cached];
            },
          }),
        },
        {
          provider: provider("sibling", {
            list: async () => {
              await sibling.promise;
              return [];
            },
          }),
        },
      ];
      const broadcastToConnIds = vi.fn();
      const pending = startCall(
        "sessions.catalog.list",
        { allowPartialResults: true, progressId: "live" },
        {},
        { connId: "requester", connect: gatewayConnect([]) },
        { broadcastToConnIds },
      );
      try {
        await vi.waitFor(() => expect(publication).toBeDefined());
        publish.resolve();
        await publication;
        expect(broadcastToConnIds).toHaveBeenCalledOnce();
        expect(pending.respond).not.toHaveBeenCalled();
        sibling.resolve();
        await pending.completion;
        expect(pending.respond).toHaveBeenCalledWith(true, {
          catalogs: [
            expect.objectContaining({ id: "fixture", hosts: [local, fresh] }),
            expect.objectContaining({ id: "sibling", hosts: [] }),
          ],
        });
      } finally {
        publish.resolve();
        sibling.resolve();
        await Promise.allSettled([pending.completion, publication]);
      }
    },
  );

  it("keeps an active list shared after 128 distinct lists settle", async () => {
    const started = createDeferredCore();
    const release = createDeferredCore();
    const list = vi.fn<SessionCatalogProvider["list"]>(async ({ search }) => {
      if (search === "held") {
        started.resolve();
        await release.promise;
      }
      return [];
    });
    hoisted.activeRegistry.sessionCatalogs = [
      { provider: provider("fixture", { list }) },
      { provider: provider("completed") },
    ];
    const config = {};
    const client = { connId: "requester", connect: gatewayConnect([]) };
    const request = { catalogId: "fixture", search: "held" };
    const leader = startCall("sessions.catalog.list", request, config, client);
    const pending = [leader];
    try {
      await started.promise;
      for (let index = 0; index < 128; index += 1) {
        const respond = await call(
          "sessions.catalog.list",
          { catalogId: "completed", search: `completed-${index}` },
          config,
          client,
        );
        expect(respond).toHaveBeenCalledWith(true, {
          catalogs: [expect.objectContaining({ id: "completed", hosts: [] })],
        });
      }
      pending.push(startCall("sessions.catalog.list", request, config, client));
      release.resolve();
      await Promise.all(pending.map(({ completion }) => completion));
      for (const { respond } of pending) {
        expect(respond).toHaveBeenCalledWith(true, {
          catalogs: [expect.objectContaining({ id: "fixture", hosts: [] })],
        });
      }
      expect(list.mock.calls.filter(([params]) => params.search === "held")).toHaveLength(1);
      await call("sessions.catalog.list", request, config, client);
      expect(list.mock.calls.filter(([params]) => params.search === "held")).toHaveLength(2);
    } finally {
      release.resolve();
      await Promise.allSettled(pending.map(({ completion }) => completion));
    }
  });

  it.each(["settled", "in-flight"] as const)(
    "refreshes %s lists immediately after archiving a session",
    async (listingState) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const gate = createDeferredCore();
      const started = createDeferredCore();
      const late = createDeferredCore();
      const publications: Promise<void>[] = [];
      const broadcastToConnIds = vi.fn();
      const session = {
        threadId: "deleted-thread",
        status: "stored",
        archived: false,
        canContinue: false,
        canArchive: true,
      };
      const host = {
        hostId: "gateway:local",
        label: "Local",
        kind: "gateway" as const,
        connected: true,
        sessions: [session],
      };
      let archived = false;
      const list = vi.fn<SessionCatalogProvider["list"]>(async ({ onHost, waitUntil }) => {
        const resultHost = { ...host, sessions: archived ? [] : [session] };
        const publication = late.promise.then(() => onHost?.(resultHost));
        publications.push(publication);
        waitUntil?.(publication);
        started.resolve();
        await gate.promise;
        return [resultHost];
      });
      hoisted.activeRegistry.sessionCatalogs = [
        {
          provider: provider("fixture", {
            list,
            archive: async () => {
              archived = true;
              return { ok: true };
            },
          }),
        },
      ];
      const config = {};
      const client = { connId: "requester", connect: gatewayConnect([]) };
      const original = startCall(
        "sessions.catalog.list",
        { progressId: "before-delete" },
        config,
        client,
        { broadcastToConnIds },
      );
      try {
        await started.promise;
        if (listingState === "settled") {
          gate.resolve();
          await original.completion;
        }
        const deletion = await call(
          "sessions.catalog.archive",
          {
            catalogId: "fixture",
            hostId: host.hostId,
            threadId: session.threadId,
            confirmNoOtherRunner: true,
          },
          config,
          client,
        );
        expect(deletion).toHaveBeenCalledWith(true, { ok: true });
        late.resolve();
        await publications[0];
        gate.resolve();
        await original.completion;
        expect(original.respond).toHaveBeenCalledWith(true, {
          catalogs: [expect.objectContaining({ hosts: [host] })],
        });

        const refreshed = await call(
          "sessions.catalog.list",
          { progressId: "after-delete" },
          config,
          client,
          { broadcastToConnIds: vi.fn() },
        );
        expect(refreshed).toHaveBeenCalledWith(true, {
          catalogs: [expect.objectContaining({ hosts: [{ ...host, sessions: [] }] })],
        });
        expect(list).toHaveBeenCalledTimes(2);
        expect(broadcastToConnIds).not.toHaveBeenCalled();
      } finally {
        gate.resolve();
        late.resolve();
        await original.completion;
        await Promise.allSettled(publications);
        now.mockRestore();
      }
    },
  );

  it.each(["gateway-close", "disconnect", "projection-failure"] as const)(
    "fences old publications after %s while a replacement request can publish",
    async (retirement) => {
      const releases = [createDeferredCore(), createDeferredCore()];
      const publications: Promise<void>[] = [];
      const connection = new AbortController();
      const gateway = new AbortController();
      const broadcastToConnIds = vi.fn();
      const replacementBroadcast = vi.fn();
      let producerSignal: AbortSignal | undefined;
      const list = vi.fn<SessionCatalogProvider["list"]>(async (params) => {
        producerSignal = params.signal;
        const publication = releases[publications.length]!.promise.then(() =>
          params.onHost?.({
            hostId: "node:late",
            label: "Late",
            kind: "node",
            connected: true,
            sessions: [],
          }),
        );
        publications.push(publication);
        params.waitUntil?.(publication);
        return [];
      });
      hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("fixture", { list }) }];
      const config = {};
      try {
        const getRuntimeConfig = vi
          .fn()
          .mockReturnValueOnce(config)
          .mockImplementation(() => {
            throw new Error("current config unavailable");
          });
        const original = call(
          "sessions.catalog.list",
          { progressId: "original" },
          config,
          { connId: "old", connect: gatewayConnect([]), connectionSignal: connection.signal },
          {
            broadcastToConnIds,
            requestEntryLifetime: { signal: gateway.signal },
            ...(retirement === "projection-failure" ? { getRuntimeConfig } : {}),
          },
        );
        if (retirement === "projection-failure") {
          await expect(original).rejects.toThrow("current config unavailable");
        } else {
          await original;
        }
        if (retirement === "gateway-close") {
          gateway.abort();
        } else if (retirement === "disconnect") {
          connection.abort();
        }
        expect(producerSignal?.aborted).toBe(retirement !== "disconnect");
        await call(
          "sessions.catalog.list",
          { progressId: "replacement" },
          config,
          { connId: "new", connect: gatewayConnect([]) },
          { broadcastToConnIds: replacementBroadcast },
        );
        releases[0]!.resolve();
        await publications[0];
        expect(broadcastToConnIds).not.toHaveBeenCalled();
        expect(replacementBroadcast).not.toHaveBeenCalled();
        expect(list).toHaveBeenCalledTimes(2);
        releases[1]!.resolve();
        await publications[1];
        expect(broadcastToConnIds).not.toHaveBeenCalled();
        expect(replacementBroadcast).toHaveBeenCalledOnce();
        expect(replacementBroadcast.mock.calls[0]?.[1]?.progressId).toBe("replacement");
      } finally {
        for (const release of releases) {
          release.resolve();
        }
        await Promise.allSettled(publications);
      }
    },
  );
});

it("keeps caller relationship queries in gateway single-flight keys and provider requests", async () => {
  resetSessionCatalogTestState();
  const gate = createDeferredCore();
  const list = vi.fn<SessionCatalogProvider["list"]>(async () => {
    await gate.promise;
    return [];
  });
  hoisted.activeRegistry.sessionCatalogs = [
    { provider: provider("shared", { list, supportsProfileRelation: true }) },
  ];
  const client = { connId: "query-caller", connect: gatewayConnect(["operator.admin"]) };
  const config = {};
  const queries = [
    undefined,
    { relationship: "owned", target: { type: "profile", id: "source-person" } },
    { relationship: "involving", target: { type: "profile", id: "source-person" } },
  ] as const;
  const pending = queries.map((profileRelation) =>
    startCall(
      "sessions.catalog.list",
      { catalogId: "shared", ...(profileRelation ? { profileRelation } : {}) },
      config,
      client,
    ),
  );
  try {
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    expect(list.mock.calls.map(([request]) => request.profileRelation)).toEqual(queries);
    expect(list.mock.calls.every(([request]) => request.caller?.id === "query-caller")).toBe(true);
  } finally {
    gate.resolve();
    await Promise.all(pending.map(({ completion }) => completion));
  }
});

it("captures polling intent before held identity resolution and shares it across pagination", async () => {
  resetSessionCatalogTestState();
  const held =
    createDeferredCore<
      Awaited<ReturnType<typeof catalogIdentity.resolveSessionCatalogProfileRelation>>
    >();
  const resolve = vi
    .spyOn(catalogIdentity, "resolveSessionCatalogProfileRelation")
    .mockImplementationOnce(() => held.promise);
  const list = vi.fn<SessionCatalogProvider["list"]>(async () => []);
  hoisted.activeRegistry.sessionCatalogs = [
    { provider: provider("shared", { list, supportsProfileRelation: true }) },
  ];
  const client = { connId: "one", connect: gatewayConnect(["operator.admin"]) };
  const config = {};
  const owned = {
    relationship: "owned",
    target: { type: "profile", id: "source-person" },
  } as const;
  const request = { catalogId: "shared", pollId: "sidebar", profileRelation: owned };
  const old = startCall(
    "sessions.catalog.list",
    { ...request, profileRelation: { relationship: "involving", target: { type: "me" } } },
    config,
    client,
  );
  try {
    await call("sessions.catalog.list", request, config, client);
    const signal = list.mock.calls[0]![0].caller!.pollSignal!;
    held.resolve({ relationship: "involving", target: { type: "github-account", id: "701" } });
    await old.completion;
    expect(old.respond.mock.calls[0]?.[0]).toBe(false);
    expect(list).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);
    await call(
      "sessions.catalog.list",
      { ...request, cursors: { "node:alpha": "cursor" } },
      config,
      client,
    );
    expect(list).toHaveBeenCalledTimes(2);
    expect(signal.aborted).toBe(false);
    expect(list.mock.calls[1]![0].profileRelation).toEqual(owned);
    await call("sessions.catalog.list", { ...request, profileRelation: undefined }, config, client);
    expect(signal.aborted).toBe(true);
    expect(list.mock.calls[1]![0].caller!.pollSignal!.aborted).toBe(true);
  } finally {
    held.resolve(undefined);
    await old.completion;
    resolve.mockRestore();
  }
});

it("retires the previous poll before unresolved me fails without retiring peer scopes", async () => {
  resetSessionCatalogTestState();
  const list = vi.fn<SessionCatalogProvider["list"]>(async () => []);
  hoisted.activeRegistry.sessionCatalogs = [
    { provider: provider("shared", { list, supportsProfileRelation: true }) },
  ];
  const client = { connId: "one", connect: gatewayConnect(["operator.admin"]) };
  const peer = { connId: "two", connect: gatewayConnect(["operator.admin"]) };
  const config = {};
  const request = { catalogId: "shared", pollId: "sidebar" };
  await call("sessions.catalog.list", request, config, client);
  await call("sessions.catalog.list", { ...request, pollId: "pane" }, config, client);
  await call("sessions.catalog.list", request, config, peer);
  const signals = list.mock.calls.map(([params]) => params.caller!.pollSignal!);
  const rejected = await call(
    "sessions.catalog.list",
    { ...request, profileRelation: { relationship: "involving", target: { type: "me" } } },
    config,
    client,
  );
  expect(rejected.mock.calls[0]?.[0]).toBe(false);
  expect(signals.map((signal) => signal.aborted)).toEqual([true, false, false]);
  expect(list).toHaveBeenCalledTimes(3);
});

it("retires the previous portable target when the same local person query resolves differently", async () => {
  resetSessionCatalogTestState();
  const resolve = vi.spyOn(catalogIdentity, "resolveSessionCatalogProfileRelation");
  const list = vi.fn<SessionCatalogProvider["list"]>(async () => []);
  hoisted.activeRegistry.sessionCatalogs = [
    { provider: provider("shared", { list, supportsProfileRelation: true }) },
  ];
  const client = { connId: "one", connect: gatewayConnect(["operator.admin"]) };
  const config = {};
  const request = {
    catalogId: "shared",
    pollId: "sidebar",
    profileRelation: { relationship: "involving", target: { type: "me" } },
  };
  try {
    resolve.mockResolvedValueOnce({
      relationship: "involving",
      target: { type: "github-account", id: "701" },
    });
    await call("sessions.catalog.list", request, config, client);
    const old = list.mock.calls[0]![0].caller!.pollSignal!;
    resolve.mockResolvedValueOnce({
      relationship: "involving",
      target: { type: "github-account", id: "702" },
    });
    await call("sessions.catalog.list", request, config, client);
    expect(old.aborted).toBe(true);
    expect(list.mock.calls[1]![0].profileRelation?.target).toEqual({
      type: "github-account",
      id: "702",
    });
    expect(list.mock.calls[1]![0].caller!.pollSignal!.aborted).toBe(false);
  } finally {
    resolve.mockRestore();
  }
});

it("retires a polling selection when the same me target loses its verified link", async () => {
  resetSessionCatalogTestState();
  const resolve = vi.spyOn(catalogIdentity, "resolveSessionCatalogProfileRelation");
  const list = vi.fn<SessionCatalogProvider["list"]>(async () => []);
  hoisted.activeRegistry.sessionCatalogs = [
    { provider: provider("shared", { list, supportsProfileRelation: true }) },
  ];
  const client = { connId: "one", connect: gatewayConnect(["operator.admin"]) };
  const config = {};
  const request = {
    catalogId: "shared",
    pollId: "sidebar",
    profileRelation: { relationship: "involving", target: { type: "me" } },
  };
  const query = {
    relationship: "involving",
    target: { type: "github-account", id: "701" },
  } as const;
  try {
    resolve.mockResolvedValueOnce(query);
    await call("sessions.catalog.list", request, config, client);
    const selected = list.mock.calls[0]![0].caller!.pollSignal!;
    await call("sessions.catalog.list", { catalogId: "shared", pollId: "peer" }, config, client);
    const peer = list.mock.calls[1]![0].caller!.pollSignal!;
    resolve.mockRejectedValueOnce(
      new Error("Profile selection requires a verified GitHub account link"),
    );
    const rejected = await call("sessions.catalog.list", request, config, client);
    expect(rejected.mock.calls[0]?.[0]).toBe(false);
    expect(selected.aborted).toBe(true);
    expect(peer.aborted).toBe(false);
    expect(list).toHaveBeenCalledTimes(2);
    resolve.mockResolvedValueOnce(query);
    await call("sessions.catalog.list", request, config, client);
    expect(list).toHaveBeenCalledTimes(3);
    expect(list.mock.calls[2]![0].caller!.pollSignal!.aborted).toBe(false);
  } finally {
    resolve.mockRestore();
  }
});

it.each([
  { outcome: "different", agentId: "main" },
  { outcome: "unresolved", agentId: "main" },
  { outcome: "different", agentId: "research" },
  { outcome: "unresolved", agentId: "research" },
] as const)(
  "does not let an older $outcome me resolution replace a newer target on $agentId",
  async ({ outcome, agentId }) => {
    resetSessionCatalogTestState();
    const held =
      createDeferredCore<
        Awaited<ReturnType<typeof catalogIdentity.resolveSessionCatalogProfileRelation>>
      >();
    const resolve = vi
      .spyOn(catalogIdentity, "resolveSessionCatalogProfileRelation")
      .mockImplementationOnce(() => held.promise);
    const list = vi.fn<SessionCatalogProvider["list"]>(async () => []);
    hoisted.activeRegistry.sessionCatalogs = [
      { provider: provider("shared", { list, supportsProfileRelation: true }) },
    ];
    const client = { connId: "one", connect: gatewayConnect(["operator.admin"]) };
    const config = { agents: { entries: { main: {}, research: {} } } };
    const request = {
      catalogId: "shared",
      pollId: "sidebar",
      profileRelation: { relationship: "involving", target: { type: "me" } },
    };
    const old = startCall("sessions.catalog.list", { ...request, agentId: "main" }, config, client);
    try {
      resolve.mockResolvedValueOnce({
        relationship: "involving",
        target: { type: "github-account", id: "702" },
      });
      await call("sessions.catalog.list", { ...request, agentId }, config, client);
      expect(list).toHaveBeenCalledTimes(1);
      const latest = list.mock.calls[0]![0].caller!.pollSignal!;
      if (outcome === "different") {
        held.resolve({ relationship: "involving", target: { type: "github-account", id: "701" } });
      } else {
        held.reject(new Error("Profile selection requires a verified GitHub account link"));
      }
      await old.completion;
      expect(old.respond.mock.calls[0]?.[0]).toBe(false);
      expect(latest.aborted).toBe(false);
      expect(list).toHaveBeenCalledTimes(1);
      expect(list.mock.calls[0]![0].profileRelation?.target).toEqual({
        type: "github-account",
        id: "702",
      });
    } finally {
      held.resolve(undefined);
      await old.completion;
      resolve.mockRestore();
    }
  },
);

it.each(["owned", "involving", "unresolved"] as const)(
  "retires switched-agent source polls before a %s replacement without stopping peers",
  async (replacement) => {
    resetSessionCatalogTestState();
    vi.useFakeTimers();
    const config = { agents: { entries: { main: {}, research: {} } } };
    const rows = ["first", "second"].map((id) => ({
      threadId: `agent:main:${id}`,
      status: "idle" as const,
      archived: false,
      canContinue: false,
      canArchive: false,
    }));
    const invokeNode = vi.fn<NonNullable<OpenClawPluginServiceContextV2["invokeNode"]>>(
      async () => ({ sessions: rows }),
    );
    const runtime = createPluginRuntimeMock({
      config: { current: () => config },
      nodes: {
        list: async () => ({
          nodes: [
            {
              nodeId: "source",
              connected: true,
              commands: ["openclaw.sessions.list.v1", "openclaw.sessions.read.v1"],
            },
          ],
        }),
        invoke: async () => {
          throw new Error("must use service authority");
        },
      },
    });
    let service: Parameters<OpenClawPluginApi["registerService"]>[0] | undefined;
    const api = createTestPluginApi({
      runtime,
      registerService: (registered) => {
        service = registered;
      },
      registerSessionCatalog: (catalog) => {
        hoisted.activeRegistry.sessionCatalogs = [{ provider: catalog }];
      },
    });
    sessionSharePlugin.register(api);
    bindPluginRegistryRuntime(hoisted.activeRegistry as PluginRegistry, runtime);
    const scheduler = createTestPluginServiceScheduler();
    const context = { config, logger: api.logger, stateDir: "/unused", invokeNode, scheduler };
    const client = { connId: "one", connect: gatewayConnect(["operator.admin"]) };
    const peer = { connId: "two", connect: gatewayConnect(["operator.admin"]) };
    const request = async (params: Record<string, unknown> = {}, caller = client) => {
      const pending = startCall(
        "sessions.catalog.list",
        { catalogId: "openclaw", pollId: "sidebar", agentId: "main", limitPerHost: 1, ...params },
        config,
        caller,
      );
      await vi.advanceTimersByTimeAsync(2);
      await pending.completion;
      return pending.respond;
    };
    const callsFor = (signal: AbortSignal | undefined) =>
      invokeNode.mock.calls.filter(([params]) => params.signal === signal).length;
    try {
      await service?.start(context);
      await request();
      const old = invokeNode.mock.calls[0]![0].signal!;
      await request({ pollId: "pane" });
      const pane = invokeNode.mock.calls[1]![0].signal!;
      await request({}, peer);
      const other = invokeNode.mock.calls[2]![0].signal!;
      const switched = await request({ agentId: "research" });
      const current = invokeNode.mock.calls[3]![0].signal!;
      expect(old.aborted).toBe(true);
      expect(current.aborted).toBe(false);
      const cursor = switched.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.nextCursor;
      expect(cursor).toEqual(expect.any(String));
      await request({ agentId: "research", cursors: { "node:source": cursor } });
      expect(invokeNode.mock.calls.at(-1)![0].signal).toBe(current);
      expect(current.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(callsFor(old)).toBe(1);
      expect(callsFor(current)).toBe(3);
      expect(callsFor(pane)).toBe(2);
      expect(callsFor(other)).toBe(2);
      const profileRelation =
        replacement === "unresolved"
          ? { relationship: "involving", target: { type: "me" } }
          : { relationship: replacement, target: { type: "profile", id: "source-person" } };
      const result = await request({ agentId: "research", profileRelation });
      expect(result.mock.calls[0]?.[0]).toBe(replacement !== "unresolved");
      expect(current.aborted).toBe(true);
      const filtered =
        replacement === "unresolved" ? undefined : invokeNode.mock.calls.at(-1)![0].signal;
      await vi.advanceTimersByTimeAsync(30_001);
      expect(callsFor(old)).toBe(1);
      expect(callsFor(current)).toBe(3);
      expect(callsFor(pane)).toBe(3);
      expect(callsFor(other)).toBe(3);
      expect(pane.aborted).toBe(false);
      expect(other.aborted).toBe(false);
      if (filtered) {
        expect(filtered.aborted).toBe(false);
        expect(callsFor(filtered)).toBe(2);
        expect(
          invokeNode.mock.calls
            .filter(([params]) => params.signal === filtered)
            .map(([params]) => params.params),
        ).toEqual([
          { limit: 100, profileRelation },
          { limit: 100, profileRelation },
        ]);
      } else {
        expect(invokeNode).toHaveBeenCalledTimes(10);
      }
    } finally {
      scheduler.beginClose();
      try {
        await service?.stop?.(context);
      } finally {
        await scheduler.stop();
      }
      vi.useRealTimers();
    }
  },
);

it("reclaims inactive polling intents without retiring an active peer", async () => {
  resetSessionCatalogTestState();
  let clock = 0;
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  const list = vi.fn<SessionCatalogProvider["list"]>(async () => []);
  hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("shared", { list }) }];
  const client = { connId: "intent-capacity", connect: gatewayConnect(["operator.admin"]) };
  const config = {};
  const request = (pollId: string) =>
    call("sessions.catalog.list", { catalogId: "shared", pollId }, config, client);
  try {
    for (let index = 0; index < 128; index++) {
      await request(`scope-${index}`);
    }
    const abandoned = list.mock.calls[1]?.[0].caller?.pollSignal;
    clock = 90_000;
    await request("scope-0");
    const active = list.mock.calls.at(-1)?.[0].caller?.pollSignal;
    clock = 120_001;
    const admitted = await request("replacement");
    expect(admitted.mock.calls[0]?.[0]).toBe(true);
    expect(abandoned?.aborted).toBe(true);
    expect(active?.aborted).toBe(false);
    await request("scope-0");
    expect(active?.aborted).toBe(false);
  } finally {
    now.mockRestore();
  }
});
