import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import {
  clearActivePluginRegistry,
  getActivePluginRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { withEnvAsync } from "../../test-utils/env.js";

const hoisted = vi.hoisted(() => ({
  listSessionEntriesReadOnly: vi.fn(() => []),
}));

vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-accessor.js")>()),
  listSessionEntriesReadOnly: hoisted.listSessionEntriesReadOnly,
}));
// HOME policy uses the real home path, but this fixture must not open its profile database.
vi.mock("../../state/user-profiles.js", () => ({
  getUserProfileRole: vi.fn(() => null),
  hasMultipleSessionSharingIdentities: vi.fn(() => false),
}));

const { sessionCatalogHandlers } = await import("./session-catalog.js");
const { listActiveSessionCatalogs } = await import("../../plugins/session-catalog-active.js");

function provider(
  id: string,
  overrides: Partial<SessionCatalogProvider> = {},
): SessionCatalogProvider {
  return {
    id,
    label: id.toUpperCase(),
    list: vi.fn(async () => []),
    read: vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] })),
    ...overrides,
  };
}

function registerCatalog(registry: PluginRegistry, catalog: SessionCatalogProvider) {
  registry.sessionCatalogs.push({ pluginId: catalog.id, source: "test", provider: catalog });
}

async function call(
  method: keyof typeof sessionCatalogHandlers,
  params: unknown,
  logGateway?: { warn: (message: string, fields?: Record<string, unknown>) => void },
) {
  const respond = vi.fn();
  await sessionCatalogHandlers[method]?.({
    params,
    respond,
    context: { getRuntimeConfig: () => ({}), ...(logGateway ? { logGateway } : {}) },
  } as never);
  return respond;
}

function withProfile<T>(profile: string | undefined, run: () => Promise<T>): Promise<T> {
  const home = os.userInfo().homedir;
  const stateDir = path.join(home, profile ? `.openclaw-${profile}` : ".openclaw");
  return withEnvAsync(
    {
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_HOME: undefined,
      OPENCLAW_PROFILE: profile,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    },
    run,
  );
}

describe("session catalog Gateway HOME isolation", () => {
  let activeRegistry: PluginRegistry;
  beforeEach(() => {
    activeRegistry = createEmptyPluginRegistry();
    setActivePluginRegistry(activeRegistry);
    hoisted.listSessionEntriesReadOnly.mockReset().mockReturnValue([]);
  });
  afterEach(() => clearActivePluginRegistry());

  it.each([true, false])("reads only the scoped registry (has catalog: %s)", async (hasCatalog) => {
    const globalCatalog = provider("global");
    registerCatalog(activeRegistry, globalCatalog);
    const scopedRegistry = createEmptyPluginRegistry();
    const scopedCatalog = provider("scoped");
    if (hasCatalog) {
      registerCatalog(scopedRegistry, scopedCatalog);
    }

    await withPluginRuntimeRegistryScope(scopedRegistry, async () => {
      await Promise.resolve();
      const catalogs = listActiveSessionCatalogs();
      expect(catalogs.map(({ id }) => id)).toEqual(hasCatalog ? ["scoped"] : []);
      for (const catalog of catalogs) {
        await catalog.list({});
        await catalog.read({ hostId: "gateway:local", threadId: "synthetic-thread" });
      }
    });

    expect(scopedCatalog.list).toHaveBeenCalledTimes(hasCatalog ? 1 : 0);
    expect(scopedCatalog.read).toHaveBeenCalledTimes(hasCatalog ? 1 : 0);
    expect(globalCatalog.list).not.toHaveBeenCalled();
    expect(globalCatalog.read).not.toHaveBeenCalled();
    expect(listActiveSessionCatalogs().map(({ id }) => id)).toEqual(["global"]);
  });

  it("leaves a cold registry uninitialized during catalog lookup", async () => {
    await clearActivePluginRegistry();

    expect(listActiveSessionCatalogs()).toEqual([]);
    expect(getActivePluginRegistry()).toBeNull();
  });

  it("suppresses only process-HOME local hosts for a named profile", async () => {
    const localHost = {
      hostId: "gateway:local",
      label: "Local",
      kind: "gateway" as const,
      connected: true,
      sessions: [],
    };
    const nodeHost = {
      hostId: "node:devbox",
      label: "Devbox",
      kind: "node" as const,
      connected: true,
      nodeId: "devbox",
      sessions: [],
    };
    const list = vi.fn(async (query: Parameters<SessionCatalogProvider["list"]>[0]) => [
      ...(query.allowProcessHomeFallback === false ? [] : [localHost]),
      nodeHost,
    ]);
    registerCatalog(activeRegistry, provider("claude", { list }));
    const logGateway = { warn: vi.fn() };

    const defaultRespond = await withProfile(undefined, () =>
      call("sessions.catalog.list", {}, logGateway),
    );
    expect(defaultRespond).toHaveBeenCalledWith(true, {
      catalogs: [expect.objectContaining({ id: "claude", hosts: [localHost, nodeHost] })],
    });

    const respond = await withProfile("dev", () => call("sessions.catalog.list", {}, logGateway));
    await withProfile("dev", () =>
      call("sessions.catalog.list", { search: "second request" }, logGateway),
    );

    expect(list).toHaveBeenCalledTimes(3);
    expect(respond).toHaveBeenCalledWith(true, {
      catalogs: [expect.objectContaining({ id: "claude", hosts: [nodeHost] })],
    });
    expect(logGateway.warn).toHaveBeenCalledOnce();
    expect(logGateway.warn).toHaveBeenCalledWith(
      "external session catalog HOME fallback skipped: isolated state; configure an explicit root to enable",
      { reason: "isolated_state" },
    );
  });

  it("binds HOME isolation into the internal read-only catalog facade", async () => {
    const localHost = {
      hostId: "gateway:local",
      label: "Local",
      kind: "gateway" as const,
      connected: true,
      sessions: [],
    };
    const list = vi.fn(async (request: { allowProcessHomeFallback?: boolean }) =>
      request.allowProcessHomeFallback === false ? [] : [localHost],
    );
    const read = vi.fn(async (request: Parameters<SessionCatalogProvider["read"]>[0]) => {
      if (request.allowProcessHomeFallback === false) {
        throw new Error("local Test sessions are unavailable in isolated state");
      }
      return { hostId: request.hostId, threadId: request.threadId, items: [] };
    });
    registerCatalog(activeRegistry, provider("test", { list, read }));

    await withProfile(undefined, async () => {
      const [catalog] = listActiveSessionCatalogs();
      expect(catalog?.processHomeFallbackAllowed).toBe(true);
      await expect(catalog?.list({})).resolves.toEqual([localHost]);
      await expect(
        catalog?.read({ hostId: "gateway:local", threadId: "known-thread" }),
      ).resolves.toMatchObject({ threadId: "known-thread" });
    });
    await withProfile("dev", async () => {
      const [catalog] = listActiveSessionCatalogs();
      expect(catalog?.processHomeFallbackAllowed).toBe(false);
      await expect(catalog?.list({})).resolves.toEqual([]);
      await expect(
        catalog?.read({ hostId: "gateway:local", threadId: "known-thread" }),
      ).rejects.toThrow("local Test sessions are unavailable in isolated state");
    });

    expect(list.mock.calls.map(([request]) => request.allowProcessHomeFallback)).toEqual([
      true,
      false,
    ]);
    expect(read.mock.calls.map(([request]) => request.allowProcessHomeFallback)).toEqual([
      true,
      false,
    ]);
  });

  it.each([
    ["continue", "continueSession", {}],
    ["archive", "archive", { confirmNoOtherRunner: true }],
  ] as const)("rejects a known local %s for a named profile", async (method, hook, extra) => {
    const rejectLocal = vi.fn(async (request: { allowProcessHomeFallback?: boolean }) => {
      if (request.allowProcessHomeFallback === false) {
        throw new Error("local Test sessions are unavailable in isolated state");
      }
      return hook === "archive" ? { ok: true as const } : { sessionKey: "agent:main:known" };
    });
    registerCatalog(
      activeRegistry,
      provider("test", { [hook]: rejectLocal } as Partial<SessionCatalogProvider>),
    );

    const respond = await withProfile("dev", () =>
      call(`sessions.catalog.${method}`, {
        catalogId: "test",
        hostId: "gateway:local",
        threadId: "known-thread",
        ...extra,
      }),
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "local Test sessions are unavailable in isolated state" }),
    );
  });
});
