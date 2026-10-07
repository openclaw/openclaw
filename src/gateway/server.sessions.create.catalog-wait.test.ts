import { afterEach, expect, test, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import * as modelCatalogRuntime from "../agents/model-catalog.runtime.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { initializeSessionReadContext } from "./server-methods/sessions-read-cache.test-support.js";
import { identifiedClient } from "./server-methods/sessions-sharing.test-support.js";
import type { GatewayClient } from "./server-methods/types.js";
import {
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
afterEach(() => vi.useRealTimers());

async function createFixture(withCapturedAuthority = false) {
  const { storePath } = await createSessionStoreDir();
  const owner = ensureProfileForEmail("catalog-wait@example.test");
  const connection = new AbortController();
  const revocation = new AbortController();
  const client: GatewayClient & { connId: string } = {
    ...identifiedClient(owner.id),
    connId: "catalog-wait",
    connectionSignal: connection.signal,
  };
  if (withCapturedAuthority) {
    client.internal = {
      operatorRunAuthority: createAdmittedRunOperatorAuthority({
        profileId: owner.id,
        scopes: client.connect.scopes ?? [],
        signal: revocation.signal,
        assertCurrent: () => revocation.signal.throwIfAborted(),
      }),
    };
  }
  const config = await getGatewayConfigModule();
  config.clearRuntimeConfigSnapshot();
  const cfg = config.getRuntimeConfig();
  const catalog = {
    agentId: "main",
    agentDir: resolveAgentDir(cfg, "main"),
    workspaceDir: resolveAgentWorkspaceDir(cfg, "main"),
    config: cfg,
    catalogComplete: true,
    entries: [{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }],
    routeVariants: [],
  };
  const context = createDirectChatContext({
    getRuntimeConfig: () => cfg,
    getClientConnIds: () => new Set(connection.signal.aborted ? [] : [client.connId]),
    readPreparedGatewayModelCatalog: async () => catalog,
    loadGatewayModelCatalogSnapshot: vi.fn(async () => catalog),
  });
  await initializeSessionReadContext(context);
  const key = "agent:main:dashboard:catalog-wait";
  const respond = vi.fn();
  const create = (model?: string, idempotencyKey = "catalog-wait") =>
    handleGatewayRequest({
      req: {
        type: "req",
        id: "catalog-wait",
        method: "sessions.create",
        params: { key, ...(model ? { model } : {}), idempotencyKey },
      },
      client,
      context,
      respond,
      isWebchatConnect: () => false,
    });
  return { storePath, connection, revocation, catalog, context, key, respond, create };
}

test.each(["deadline", "disconnect", "authority revocation"])(
  "sessions.create ends a stalled catalog wait on %s without a late commit",
  async (reason) => {
    const fixture = await createFixture(reason === "authority revocation");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    vi.mocked(fixture.context.loadGatewayModelCatalogSnapshot).mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return fixture.catalog;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const creating = fixture.create("openai/gpt-4.1");
    try {
      await Promise.race([entered.promise, creating]);
      expect(fixture.respond).not.toHaveBeenCalled();
      if (reason === "disconnect") {
        fixture.connection.abort();
      } else if (reason === "authority revocation") {
        fixture.revocation.abort(new Error("Operator authority revoked"));
        expect(fixture.connection.signal.aborted).toBe(false);
      }
      await vi.advanceTimersByTimeAsync(reason === "deadline" ? 20_000 : 0);
      expect(fixture.respond.mock.calls[0]?.slice(0, 3)).toEqual([
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: expect.stringMatching(/model catalog.*loading.*session.*not created.*retry/i),
        }),
      ]);
      await creating;
      expect(
        loadSessionEntry({ sessionKey: fixture.key, storePath: fixture.storePath }),
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
      release.resolve();
      await creating;
    }
    expect(
      loadSessionEntry({ sessionKey: fixture.key, storePath: fixture.storePath }),
    ).toBeUndefined();
    if (reason === "deadline") {
      fixture.respond.mockClear();
      await fixture.create("openai/gpt-4.1");
      expect(fixture.respond.mock.calls[0]?.[0]).toBe(true);
      expect(
        loadSessionEntry({ sessionKey: fixture.key, storePath: fixture.storePath }),
      ).toBeDefined();
    }
  },
);

test("sessions.create without catalog-dependent fields never waits on catalog publication", async () => {
  const fixture = await createFixture();
  vi.mocked(fixture.context.loadGatewayModelCatalogSnapshot).mockImplementation(
    () => new Promise(() => {}),
  );
  await fixture.create();
  expect(fixture.respond.mock.calls[0]?.[0]).toBe(true);
  expect(fixture.context.loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
  expect(loadSessionEntry({ sessionKey: fixture.key, storePath: fixture.storePath })).toBeDefined();
});

test("sessions.create with a ready catalog preserves the selected model", async () => {
  const fixture = await createFixture();
  await fixture.create("openai/gpt-4.1");
  expect(fixture.respond.mock.calls[0]?.[0]).toBe(true);
  expect(loadSessionEntry({ sessionKey: fixture.key, storePath: fixture.storePath })).toMatchObject(
    {
      providerOverride: "openai",
      modelOverride: "gpt-4.1",
    },
  );
});

test("sessions.create does not await unused thinking catalog hydration", async () => {
  const fixture = await createFixture();
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const hydration = vi
    .spyOn(modelCatalogRuntime, "loadProviderScopedThinkingCatalog")
    .mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return [];
    });
  const creating = fixture.create("openai/gpt-4.1");
  try {
    expect(
      await Promise.race([creating.then(() => "created"), entered.promise.then(() => "hydrating")]),
    ).toBe("created");
    expect(fixture.respond.mock.calls[0]?.[0]).toBe(true);
    expect(
      loadSessionEntry({ sessionKey: fixture.key, storePath: fixture.storePath }),
    ).toBeDefined();
  } finally {
    release.resolve();
    await creating;
    hydration.mockRestore();
  }
});

test.each([-3_600_000, 3_600_000])(
  "sessions.create shares its catalog deadline across reads despite a %s ms clock step",
  async (clockStep) => {
    const fixture = await createFixture();
    await fixture.create("openai/gpt-4.1", "seed");
    const before = loadSessionEntry({ sessionKey: fixture.key, storePath: fixture.storePath });
    const entered = [createDeferredCore(), createDeferredCore()];
    const release = [createDeferredCore(), createDeferredCore()];
    for (const index of [0, 1]) {
      vi.mocked(fixture.context.loadGatewayModelCatalogSnapshot).mockImplementationOnce(
        async () => {
          entered[index]!.resolve();
          await release[index]!.promise;
          return fixture.catalog;
        },
      );
    }
    fixture.respond.mockClear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const creating = fixture.create("openai/gpt-4.1");
    try {
      await Promise.race([entered[0]!.promise, creating]);
      await vi.advanceTimersByTimeAsync(10_000);
      vi.setSystemTime(Date.now() + clockStep);
      release[0]!.resolve();
      await Promise.race([entered[1]!.promise, creating]);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(fixture.respond).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(fixture.respond.mock.calls[0]?.slice(0, 3)).toEqual([
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
      ]);
      await creating;
      expect(loadSessionEntry({ sessionKey: fixture.key, storePath: fixture.storePath })).toEqual(
        before,
      );
    } finally {
      vi.useRealTimers();
      for (const gate of release) {
        gate.resolve();
      }
      await creating;
    }
  },
);
