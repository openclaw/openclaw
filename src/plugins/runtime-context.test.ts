import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { bindPluginCacheRoot, createPluginCache, withPluginCache } from "./plugin-cache.js";
import { PluginInstance } from "./plugin-instance.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { resolvePluginRuntimeRecord } from "./runtime-context.js";
import { withPluginRegistrationContext } from "./runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-fixtures.js";

const fixturePath = (...parts: string[]) => path.resolve("runtime-owner-fixture", ...parts);
function registryWith(...records: ReturnType<typeof createPluginRecord>[]) {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(...records);
  return registry;
}
function withRequest<T>(
  pluginRegistry: ReturnType<typeof createEmptyPluginRegistry>,
  pluginId: string | undefined,
  run: () => T,
) {
  return withPluginCache(createPluginCache(), () =>
    withPluginRuntimeGatewayRequestScope(
      { pluginRegistry, pluginId, isWebchatConnect: () => false },
      run,
    ),
  );
}
function expectOwner(
  params: Parameters<typeof resolvePluginRuntimeRecord>[0],
  owner?: ReturnType<typeof createPluginRecord>,
) {
  expect(resolvePluginRuntimeRecord(params)).toBe(owner);
}
function expectAmbiguous(params: Parameters<typeof resolvePluginRuntimeRecord>[0]) {
  expect(() => resolvePluginRuntimeRecord(params)).toThrow(/ambiguous runtime ownership/);
}

describe("plugin runtime record source ownership", () => {
  it.each([
    ["root", 0],
    ["root", 8],
    ["root", 16],
    ["module", 0],
    ["module", 8],
    ["module", 16],
  ] as const)(
    "resolves %s owner at position %i without unrelated source checks",
    async (kind, index) => {
      const cache = createPluginCache();
      const registry = createEmptyPluginRegistry();
      const records = Array.from({ length: 17 }, (_, offset) =>
        createPluginRecord({
          id: `plugin-${offset}`,
          rootDir: path.resolve("runtime-owner-fixture", String(offset)),
        }),
      );
      registry.plugins.push(...records);
      const owner = records[index]!;
      const modulePath = path.resolve("runtime-owner-fixture/captured/api.js");
      const membership = records.map((record) =>
        vi.fn((source: string) => record === owner && source === modulePath),
      );
      const instances = records.map((record, offset) => {
        const instance = new PluginInstance(record.id, { record, registry });
        instance.bindModuleLoader(() => ({}), membership[offset]);
        return instance;
      });
      try {
        withPluginCache(cache, () =>
          withPluginRuntimeGatewayRequestScope(
            { pluginRegistry: registry, isWebchatConnect: () => false },
            () => {
              const params = kind === "root" ? { pluginRoot: owner.rootDir! } : { modulePath };
              expect(resolvePluginRuntimeRecord({ ...params, pluginId: owner.id })).toBe(owner);
              if (kind === "root") {
                expect([...cache.roots.keys()]).toEqual([owner.rootDir]);
              } else {
                membership.forEach((hasSource, offset) =>
                  expect(hasSource).toHaveBeenCalledTimes(offset === index ? 1 : 0),
                );
              }
            },
          ),
        );
      } finally {
        await Promise.all(instances.map((instance) => instance.dispose()));
      }
    },
  );

  it.each(["owner", ""])("checks rejected sources once for plugin id %s", async (pluginId) => {
    const modulePath = fixturePath("missing/api.js");
    const record = createPluginRecord({ id: pluginId, rootDir: fixturePath("owner") });
    const registry = registryWith(record);
    const membership = vi.fn(() => false);
    const instance = new PluginInstance(record.id, { record, registry });
    instance.bindModuleLoader(() => ({}), membership);
    const duplicate = createPluginRecord({ id: pluginId, rootDir: record.rootDir });
    const duplicateMembership = vi.fn(() => false);
    const duplicateInstance = new PluginInstance(duplicate.id, { record: duplicate, registry });
    duplicateInstance.bindModuleLoader(() => ({}), duplicateMembership);
    const foreign = createPluginRecord({ id: "foreign", rootDir: path.dirname(modulePath) });
    try {
      withRequest(registry, undefined, () => {
        const params = { pluginId, modulePath };
        expectOwner(params);
        expect(membership).toHaveBeenCalledTimes(1);

        membership.mockClear();
        registry.plugins.push(duplicate, foreign);
        if (pluginId) {
          expectAmbiguous(params);
        } else {
          expectOwner(params, foreign);
        }
        expect(membership).toHaveBeenCalledTimes(1);
        expect(duplicateMembership).toHaveBeenCalledTimes(1);
      });
    } finally {
      await Promise.all([instance.dispose(), duplicateInstance.dispose()]);
    }
  });

  it("selects the first source-matching duplicate id through canonical root aliases", () => {
    const rootDir = fixturePath("owner");
    const alias = fixturePath("alias");
    const first = createPluginRecord({ id: "owner", rootDir, status: "disabled", enabled: false });
    const registry = registryWith(
      createPluginRecord({ id: "owner", rootDir: fixturePath("other") }),
      createPluginRecord({ id: "foreign", rootDir }),
      first,
      createPluginRecord({ id: "owner", rootDir }),
    );
    withRequest(registry, undefined, () => {
      bindPluginCacheRoot(alias, rootDir);
      for (const location of [
        { pluginRoot: alias },
        { modulePath: path.join(rootDir, "api.js") },
      ]) {
        expectOwner({ ...location, pluginId: "owner" }, first);
        expectAmbiguous({ ...location, pluginId: "Owner" });
      }
    });
  });

  it("retains unique-root fallback and explicit-id ambiguity when a scoped id misses", () => {
    const rootDir = fixturePath("owner");
    const owner = createPluginRecord({ id: "owner", rootDir });
    const registry = registryWith(owner);
    withRequest(registry, "missing", () => {
      const location = { pluginRoot: rootDir };
      expectOwner(location, owner);
      expectOwner({ ...location, pluginId: "" }, owner);
      expectAmbiguous({ ...location, pluginId: "missing" });
      expectOwner({ pluginRoot: fixturePath("unknown"), pluginId: "missing" });
      registry.plugins.push(createPluginRecord({ id: "sibling", rootDir }));
      expectAmbiguous(location);
    });
  });

  it("preserves explicit, registration and request identities with nested scope restoration", () => {
    const pluginRoot = fixturePath("owner");
    const registration = createPluginRecord({ id: "registration", rootDir: pluginRoot });
    const explicit = createPluginRecord({ id: "explicit", rootDir: pluginRoot });
    const request = createPluginRecord({ id: "request", rootDir: pluginRoot });
    const registrationRegistry = registryWith(registration, explicit);
    const requestRegistry = registryWith(request);
    withRequest(requestRegistry, request.id, () => {
      expectOwner({ pluginRoot }, request);
      withPluginRegistrationContext(registrationRegistry, registration.id, () => {
        expectOwner({ pluginRoot }, registration);
        expectOwner({ pluginRoot, pluginId: explicit.id }, explicit);
      });
      expectOwner({ pluginRoot }, request);
      withPluginRegistrationContext(requestRegistry, "missing", () => {
        expectOwner({ pluginRoot }, request);
      });
    });
  });

  it("rechecks captured membership after awaits, growth and disposal", async () => {
    const modulePath = fixturePath("captured/api.js");
    const record = createPluginRecord({ id: "owner", rootDir: fixturePath("owner") });
    const registry = registryWith(record);
    const members = new Set<string>();
    const instance = new PluginInstance(record.id, { record, registry });
    instance.bindModuleLoader(
      () => ({}),
      (source) => members.has(source),
    );
    try {
      await withRequest(registry, undefined, async () => {
        const params = { modulePath, pluginId: record.id };
        expectOwner(params);
        members.add(modulePath);
        await Promise.resolve();
        expectOwner(params, record);
        members.delete(modulePath);
        expectOwner(params);
        members.add(modulePath);
        await instance.dispose();
        expect(instance.hasModuleSource(modulePath)).toBe(false);
        expectOwner(params);
        expect(() => instance.loadModule(modulePath)).toThrow(/reloaded or disabled/);
      });
    } finally {
      await instance.dispose();
    }
  });

  it("resolves unrelated modules while a captured instance releases module resources", async () => {
    const registry = createEmptyPluginRegistry();
    const retired = createPluginRecord({ id: "retired", rootDir: path.resolve("retired") });
    const current = createPluginRecord({ id: "current", rootDir: path.resolve("current") });
    registry.plugins.push(retired, current);
    const instance = new PluginInstance(retired.id, { record: retired, registry });
    const captured = path.resolve("captured/api.js");
    const callFinished = createDeferredCore();
    const cleanupEntered = createDeferredCore();
    const cleanupFinished = createDeferredCore();
    let releasingModules = false;
    instance.bindModuleLoader(
      () => ({}),
      (source) => {
        if (releasingModules) {
          throw new Error("Captured source owner is releasing its resources");
        }
        return source === captured;
      },
    );
    instance.onModuleDispose(async () => {
      releasingModules = true;
      cleanupEntered.resolve();
      await cleanupFinished.promise;
    });
    const call = instance.run(() => callFinished.promise);
    const disposal = instance.dispose();
    try {
      withRequest(registry, undefined, () => expectOwner({ modulePath: captured }, retired));
      callFinished.resolve();
      await cleanupEntered.promise;
      withRequest(registry, undefined, () => {
        expectOwner({ modulePath: path.resolve("current/api.js") }, current);
        expectOwner({ modulePath: captured });
      });
      expect(instance.owner?.registry).toBe(registry);
      cleanupFinished.resolve();
      await Promise.all([call, disposal]);
      expect(instance.owner?.registry).toBeUndefined();
      expect(instance.hasModuleSource(captured)).toBe(false);
      expect(() => instance.loadModule(retired.source)).toThrow(/reloaded or disabled/);
    } finally {
      callFinished.resolve();
      cleanupFinished.resolve();
      await Promise.allSettled([call, disposal]);
    }
  });

  it.each([
    ["plugin", "plugin/api.js", true],
    ["plugin", "plugin", true],
    ["plugin/", "plugin/api.js", true],
    ["plugin/.", "plugin/api.js", true],
    ["plugin/../owner", "owner/api.js", true],
    ["plugin", "plugin/subdir/../api.js", true],
    ["plugin", "plugin-sibling/api.js", false],
    ["plugin", "plugin/../owner/api.js", false],
    ["plugin", "owner/api.js", false],
  ] as const)("matches root %s against source %s (%s)", (root, source, matches) => {
    const base = fixturePath();
    const record = createPluginRecord({ id: "owner", rootDir: `${base}${path.sep}${root}` });
    const registry = registryWith(record);
    withRequest(registry, undefined, () => {
      const params = { modulePath: `${base}${path.sep}${source}` };
      expectOwner(params, matches ? record : undefined);
      expectOwner(params, matches ? record : undefined);
    });
  });

  it.each([undefined, "owner"])(
    "keeps changed roots and registry scopes live with plugin id %s",
    (pluginId) => {
      const modulePath = fixturePath("plugin/api.js");
      const params = pluginId ? { modulePath, pluginId } : { modulePath };
      const record = createPluginRecord({ id: "owner", rootDir: path.parse(modulePath).root });
      const registry = registryWith(record);
      const otherRecord = createPluginRecord({ id: "other", rootDir: path.dirname(modulePath) });
      const otherRegistry = registryWith(otherRecord);
      withRequest(registry, undefined, () => {
        expectOwner(params, record);
        record.rootDir = fixturePath("unrelated");
        expectOwner(params);
        withPluginRuntimeGatewayRequestScope(
          { pluginRegistry: otherRegistry, isWebchatConnect: () => false },
          () => expect(resolvePluginRuntimeRecord({ modulePath })).toBe(otherRecord),
        );
        expectOwner(params);
        record.rootDir = path.dirname(modulePath);
        expectOwner(params, record);
      });
    },
  );
});
