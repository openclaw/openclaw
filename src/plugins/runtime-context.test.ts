import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { bindPluginCacheRoot, createPluginCache, withPluginCache } from "./plugin-cache.js";
import { PluginInstance } from "./plugin-instance.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { resolvePluginRuntimeRecord } from "./runtime-context.js";
import { withPluginRegistrationContext } from "./runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-fixtures.js";

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
    const registry = createEmptyPluginRegistry();
    const modulePath = path.resolve("runtime-owner-fixture/missing/api.js");
    const record = createPluginRecord({
      id: pluginId,
      rootDir: path.resolve("runtime-owner-fixture/owner"),
    });
    registry.plugins.push(record);
    const membership = vi.fn(() => false);
    const instance = new PluginInstance(record.id, { record, registry });
    instance.bindModuleLoader(() => ({}), membership);
    const duplicate = createPluginRecord({ id: pluginId, rootDir: record.rootDir });
    const duplicateMembership = vi.fn(() => false);
    const duplicateInstance = new PluginInstance(duplicate.id, { record: duplicate, registry });
    duplicateInstance.bindModuleLoader(() => ({}), duplicateMembership);
    const foreign = createPluginRecord({ id: "foreign", rootDir: path.dirname(modulePath) });
    try {
      withPluginCache(createPluginCache(), () =>
        withPluginRuntimeGatewayRequestScope(
          { pluginRegistry: registry, isWebchatConnect: () => false },
          () => {
            const params = { pluginId, modulePath };
            expect(resolvePluginRuntimeRecord(params)).toBeUndefined();
            expect(membership).toHaveBeenCalledTimes(1);

            membership.mockClear();
            registry.plugins.push(duplicate, foreign);
            if (pluginId) {
              expect(() => resolvePluginRuntimeRecord(params)).toThrow(
                /ambiguous runtime ownership/,
              );
            } else {
              expect(resolvePluginRuntimeRecord(params)).toBe(foreign);
            }
            expect(membership).toHaveBeenCalledTimes(1);
            expect(duplicateMembership).toHaveBeenCalledTimes(1);
          },
        ),
      );
    } finally {
      await Promise.all([instance.dispose(), duplicateInstance.dispose()]);
    }
  });

  it("selects the first source-matching duplicate id through canonical root aliases", () => {
    const rootDir = path.resolve("runtime-owner-fixture/owner");
    const alias = path.resolve("runtime-owner-fixture/alias");
    const first = createPluginRecord({ id: "owner", rootDir, status: "disabled", enabled: false });
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({ id: "owner", rootDir: path.resolve("runtime-owner-fixture/other") }),
      createPluginRecord({ id: "foreign", rootDir }),
      first,
      createPluginRecord({ id: "owner", rootDir }),
    );
    withPluginCache(createPluginCache(), () => {
      bindPluginCacheRoot(alias, rootDir);
      withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: registry, isWebchatConnect: () => false },
        () => {
          for (const location of [
            { pluginRoot: alias },
            { modulePath: path.join(rootDir, "api.js") },
          ]) {
            expect(resolvePluginRuntimeRecord({ ...location, pluginId: "owner" })).toBe(first);
            expect(() => resolvePluginRuntimeRecord({ ...location, pluginId: "Owner" })).toThrow(
              /ambiguous runtime ownership/,
            );
          }
        },
      );
    });
  });

  it("retains unique-root fallback and explicit-id ambiguity when a scoped id misses", () => {
    const rootDir = path.resolve("runtime-owner-fixture/owner");
    const owner = createPluginRecord({ id: "owner", rootDir });
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(owner);
    withPluginCache(createPluginCache(), () =>
      withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: registry, pluginId: "missing", isWebchatConnect: () => false },
        () => {
          const location = { pluginRoot: rootDir };
          expect(resolvePluginRuntimeRecord(location)).toBe(owner);
          expect(resolvePluginRuntimeRecord({ ...location, pluginId: "" })).toBe(owner);
          expect(() => resolvePluginRuntimeRecord({ ...location, pluginId: "missing" })).toThrow(
            /ambiguous runtime ownership/,
          );
          expect(
            resolvePluginRuntimeRecord({
              pluginRoot: path.resolve("runtime-owner-fixture/unknown"),
              pluginId: "missing",
            }),
          ).toBeUndefined();
          registry.plugins.push(createPluginRecord({ id: "sibling", rootDir }));
          expect(() => resolvePluginRuntimeRecord(location)).toThrow(/ambiguous runtime ownership/);
        },
      ),
    );
  });

  it("preserves explicit, registration and request identities with nested scope restoration", () => {
    const pluginRoot = path.resolve("runtime-owner-fixture/owner");
    const registration = createPluginRecord({ id: "registration", rootDir: pluginRoot });
    const explicit = createPluginRecord({ id: "explicit", rootDir: pluginRoot });
    const request = createPluginRecord({ id: "request", rootDir: pluginRoot });
    const registrationRegistry = createEmptyPluginRegistry();
    registrationRegistry.plugins.push(registration, explicit);
    const requestRegistry = createEmptyPluginRegistry();
    requestRegistry.plugins.push(request);
    withPluginCache(createPluginCache(), () =>
      withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: requestRegistry, pluginId: request.id, isWebchatConnect: () => false },
        () => {
          expect(resolvePluginRuntimeRecord({ pluginRoot })).toBe(request);
          withPluginRegistrationContext(registrationRegistry, registration.id, () => {
            expect(resolvePluginRuntimeRecord({ pluginRoot })).toBe(registration);
            expect(resolvePluginRuntimeRecord({ pluginRoot, pluginId: explicit.id })).toBe(
              explicit,
            );
          });
          expect(resolvePluginRuntimeRecord({ pluginRoot })).toBe(request);
          withPluginRegistrationContext(requestRegistry, "missing", () => {
            expect(resolvePluginRuntimeRecord({ pluginRoot })).toBe(request);
          });
        },
      ),
    );
  });

  it("rechecks captured membership after awaits, growth and disposal", async () => {
    const modulePath = path.resolve("runtime-owner-fixture/captured/api.js");
    const record = createPluginRecord({
      id: "owner",
      rootDir: path.resolve("runtime-owner-fixture/owner"),
    });
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(record);
    const members = new Set<string>();
    const instance = new PluginInstance(record.id, { record, registry });
    instance.bindModuleLoader(
      () => ({}),
      (source) => members.has(source),
    );
    try {
      await withPluginCache(createPluginCache(), () =>
        withPluginRuntimeGatewayRequestScope(
          { pluginRegistry: registry, isWebchatConnect: () => false },
          async () => {
            const params = { modulePath, pluginId: record.id };
            expect(resolvePluginRuntimeRecord(params)).toBeUndefined();
            members.add(modulePath);
            await Promise.resolve();
            expect(resolvePluginRuntimeRecord(params)).toBe(record);
            members.delete(modulePath);
            expect(resolvePluginRuntimeRecord(params)).toBeUndefined();
            members.add(modulePath);
            await instance.dispose();
            expect(instance.hasModuleSource(modulePath)).toBe(false);
            expect(resolvePluginRuntimeRecord(params)).toBeUndefined();
            expect(() => instance.loadModule(modulePath)).toThrow(/reloaded or disabled/);
          },
        ),
      );
    } finally {
      await instance.dispose();
    }
  });

  it("resolves unrelated modules after a captured instance is disposed", async () => {
    const registry = createEmptyPluginRegistry();
    const retired = createPluginRecord({ id: "retired", rootDir: path.resolve("retired") });
    const current = createPluginRecord({ id: "current", rootDir: path.resolve("current") });
    registry.plugins.push(retired, current);
    const instance = new PluginInstance(retired.id, { record: retired, registry });
    instance.bindModuleLoader(
      () => ({}),
      (source) => source === retired.source,
    );
    await instance.dispose();
    withPluginCache(createPluginCache(), () =>
      withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: registry, isWebchatConnect: () => false },
        () => {
          expect(resolvePluginRuntimeRecord({ modulePath: path.resolve("current/api.js") })).toBe(
            current,
          );
          expect(
            resolvePluginRuntimeRecord({ modulePath: path.resolve("unknown/api.js") }),
          ).toBeUndefined();
          expect(() => instance.loadModule(retired.source)).toThrow(/reloaded or disabled/);
        },
      ),
    );
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
    const base = path.resolve("runtime-owner-fixture");
    const record = createPluginRecord({ id: "owner", rootDir: `${base}${path.sep}${root}` });
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(record);
    withPluginCache(createPluginCache(), () =>
      withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: registry, isWebchatConnect: () => false },
        () => {
          const params = { modulePath: `${base}${path.sep}${source}` };
          expect(resolvePluginRuntimeRecord(params)).toBe(matches ? record : undefined);
          expect(resolvePluginRuntimeRecord(params)).toBe(matches ? record : undefined);
        },
      ),
    );
  });

  it.each([undefined, "owner"])(
    "keeps changed roots and registry scopes live with plugin id %s",
    (pluginId) => {
      const modulePath = path.resolve("runtime-owner-fixture/plugin/api.js");
      const params = pluginId ? { modulePath, pluginId } : { modulePath };
      const record = createPluginRecord({ id: "owner", rootDir: path.parse(modulePath).root });
      const registry = createEmptyPluginRegistry();
      registry.plugins.push(record);
      const otherRegistry = createEmptyPluginRegistry();
      const otherRecord = createPluginRecord({ id: "other", rootDir: path.dirname(modulePath) });
      otherRegistry.plugins.push(otherRecord);
      withPluginCache(createPluginCache(), () =>
        withPluginRuntimeGatewayRequestScope(
          { pluginRegistry: registry, isWebchatConnect: () => false },
          () => {
            expect(resolvePluginRuntimeRecord(params)).toBe(record);
            record.rootDir = path.resolve("runtime-owner-fixture/unrelated");
            expect(resolvePluginRuntimeRecord(params)).toBeUndefined();
            withPluginRuntimeGatewayRequestScope(
              { pluginRegistry: otherRegistry, isWebchatConnect: () => false },
              () => expect(resolvePluginRuntimeRecord({ modulePath })).toBe(otherRecord),
            );
            expect(resolvePluginRuntimeRecord(params)).toBeUndefined();
            record.rootDir = path.dirname(modulePath);
            expect(resolvePluginRuntimeRecord(params)).toBe(record);
          },
        ),
      );
    },
  );
});
