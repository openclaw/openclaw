import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";
import {
  catalogHost,
  catalogProvider as provider,
  expectCatalog,
} from "./session-catalog.fixtures.test-support.js";

// mock-isolation: HOME policy uses the real home path but must not open its profile database.
vi.mock("../../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/user-profile-list.js")>()),
  hasMultipleResidentSessionSharingIdentities: vi.fn(() => false),
  readResidentUserProfileAliases: (id: string) => new Set([id]),
}));

const { sessionCatalogHandlers } = await import("./session-catalog.js");
const { listActiveSessionCatalogs } = await import("../../plugins/session-catalog-active.js");
let projection: ReturnType<typeof createSessionRowProjectionFixture>;

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
    context: bindSessionRowProjection(
      { getRuntimeConfig: () => ({}), ...(logGateway ? { logGateway } : {}) },
      () => projection,
    ),
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

let activeRegistry: PluginRegistry;
beforeEach(() => {
  activeRegistry = createEmptyPluginRegistry();
  setActivePluginRegistry(activeRegistry);
  projection = createSessionRowProjectionFixture({ cfg: {}, store: {} });
});
afterEach(async () => {
  projection.dispose();
  await clearActivePluginRegistry();
});

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

it("suppresses only process-HOME local hosts for a named profile", async () => {
  const localHost = catalogHost();
  const nodeHost = catalogHost({ hostId: "node:devbox", kind: "node", nodeId: "devbox" });
  const list = async (query: Parameters<SessionCatalogProvider["list"]>[0]) => [
    ...(query.allowProcessHomeFallback === false ? [] : [localHost]),
    nodeHost,
  ];
  registerCatalog(activeRegistry, provider("claude", { list }));
  const logGateway = { warn: vi.fn() };

  const defaultRespond = await withProfile(undefined, () =>
    call("sessions.catalog.list", {}, logGateway),
  );
  expectCatalog(defaultRespond, { id: "claude", hosts: [localHost, nodeHost] });

  const respond = await withProfile("dev", () => call("sessions.catalog.list", {}, logGateway));
  await withProfile("dev", () =>
    call("sessions.catalog.list", { search: "second request" }, logGateway),
  );

  expectCatalog(respond, { id: "claude", hosts: [nodeHost] });
  expect(logGateway.warn).toHaveBeenCalledOnce();
  expect(logGateway.warn.mock.calls[0]?.[1]).toEqual({ reason: "isolated_state" });
});

it("binds HOME isolation into the internal read-only catalog facade", async () => {
  const localHost = catalogHost();
  const list = async (request: { allowProcessHomeFallback?: boolean }) =>
    request.allowProcessHomeFallback === false ? [] : [localHost];
  const read = async (request: Parameters<SessionCatalogProvider["read"]>[0]) => {
    if (request.allowProcessHomeFallback === false) {
      throw new Error("local Test sessions are unavailable in isolated state");
    }
    return { hostId: request.hostId, threadId: request.threadId, items: [] };
  };
  registerCatalog(activeRegistry, provider("test", { list, read }));

  for (const profile of [undefined, "dev"]) {
    await withProfile(profile, async () => {
      const [catalog] = listActiveSessionCatalogs();
      expect(catalog?.processHomeFallbackAllowed).toBe(!profile);
      await expect(catalog?.list({})).resolves.toEqual(profile ? [] : [localHost]);
      const reading = expect(catalog?.read({ hostId: "gateway:local", threadId: "known-thread" }));
      if (profile) {
        await reading.rejects.toThrow("local Test sessions are unavailable in isolated state");
      } else {
        await reading.resolves.toMatchObject({ threadId: "known-thread" });
      }
    });
  }
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
