/**
 * Gateway method registry tests.
 */
import { describe, expect, it, vi } from "vitest";
import type { GatewayMethodAccessPolicy } from "../authorization/contracts.js";
import { ADMIN_SCOPE, READ_SCOPE, WRITE_SCOPE } from "../operator-scopes.js";
import type { GatewayRequestHandler } from "../server-methods/types.js";
import {
  createGatewayMethodRegistry,
  createPluginGatewayMethodDescriptors,
  createPluginGatewayMethodDescriptor,
} from "./registry.js";

const handler: GatewayRequestHandler = ({ respond }) => respond(true, { ok: true });

describe("gateway method registry", () => {
  it("indexes handlers, scopes, startup state, and control-plane metadata", () => {
    const access = {
      kind: "resource" as const,
      permission: "example.read",
      resolveResources: () => [{ namespace: "core", type: "example", id: "one" }],
    };
    const registry = createGatewayMethodRegistry([
      {
        name: "example.read",
        handler,
        scope: READ_SCOPE,
        owner: { kind: "core", area: "test" },
        access,
      },
      {
        name: "example.write",
        handler,
        scope: WRITE_SCOPE,
        owner: { kind: "core", area: "test" },
        startup: "unavailable-until-sidecars",
        controlPlaneWrite: true,
        advertise: false,
      },
    ]);

    expect(registry.listMethods()).toEqual(["example.read", "example.write"]);
    expect(registry.listAdvertisedMethods()).toEqual(["example.read"]);
    expect(registry.getHandler("example.read")).toBe(handler);
    expect(registry.getScope("example.write")).toBe(WRITE_SCOPE);
    expect(registry.getAccessPolicy("example.read")).toBe(access);
    expect(registry.getAccessPolicy("example.write")).toBeUndefined();
    expect(registry.isStartupUnavailable("example.write")).toBe(true);
    expect(registry.isControlPlaneWrite("example.write")).toBe(true);
  });

  it("rejects a blank resource permission", () => {
    expect(() =>
      createGatewayMethodRegistry([
        {
          name: "example.blank-permission",
          handler,
          scope: READ_SCOPE,
          owner: { kind: "core", area: "test" },
          access: {
            kind: "resource",
            permission: "   ",
            resolveResources: () => [{ namespace: "core", type: "example", id: "one" }],
          },
        },
      ]),
    ).toThrow("gateway method access permission must not be empty: example.blank-permission");
  });

  it("rejects duplicate method names", () => {
    expect(() =>
      createGatewayMethodRegistry([
        {
          name: "example.duplicate",
          handler,
          scope: READ_SCOPE,
          owner: { kind: "core", area: "test" },
        },
        {
          name: "example.duplicate",
          handler,
          scope: WRITE_SCOPE,
          owner: { kind: "core", area: "test" },
        },
      ]),
    ).toThrow("gateway method already registered: example.duplicate");
  });

  it("coerces reserved plugin namespaces to admin scope", () => {
    const descriptor = createPluginGatewayMethodDescriptor({
      pluginId: "demo",
      name: "config.demo",
      handler,
      scope: READ_SCOPE,
    });

    const registry = createGatewayMethodRegistry([descriptor]);

    expect(registry.getScope("config.demo")).toBe(ADMIN_SCOPE);
    expect(registry.descriptors()[0]?.owner).toEqual({ kind: "plugin", pluginId: "demo" });
  });

  it("rejects a raw plugin attempt to mark a gateway method public", () => {
    expect(() =>
      createPluginGatewayMethodDescriptor({
        pluginId: "demo",
        name: "demo.public",
        handler,
        access: { kind: "public" },
      }),
    ).toThrow(/plugin gateway method access must be resource-scoped/i);
  });

  it("copies and freezes plugin access policy instead of retaining plugin objects", async () => {
    const resource = { namespace: "demo", type: "card", id: "card-1" };
    const access = {
      kind: "resource" as "resource" | "public",
      permission: "demo.card.read",
      resolveResources: () => [resource],
    };
    const registry = createGatewayMethodRegistry([
      createPluginGatewayMethodDescriptor({
        pluginId: "demo",
        name: "demo.card.get",
        handler,
        access: access as GatewayMethodAccessPolicy,
      }),
    ]);

    access.kind = "public";
    access.permission = "demo.card.write";

    const stored = registry.getAccessPolicy("demo.card.get");
    expect(stored).not.toBe(access);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(stored).toMatchObject({ kind: "resource", permission: "demo.card.read" });
    if (stored?.kind !== "resource") {
      throw new Error("expected canonical resource access policy");
    }
    await expect(
      stored.resolveResources({ method: "demo.card.get", params: {}, config: {} }),
    ).resolves.toEqual([{ namespace: "demo", type: "card", id: "card-1" }]);
  });

  it("snapshots plugin policy getters and rejects foreign resource namespaces", async () => {
    const reads = { kind: 0, permission: 0, resolver: 0 };
    const resolveResources = vi.fn(() => [
      { namespace: "other-plugin", type: "card", id: "card-1" },
    ]);
    const access = Object.defineProperties(
      {},
      {
        kind: {
          get: () => {
            reads.kind += 1;
            return "resource";
          },
        },
        permission: {
          get: () => {
            reads.permission += 1;
            return "demo.card.read";
          },
        },
        resolveResources: {
          get: () => {
            reads.resolver += 1;
            return resolveResources;
          },
        },
      },
    ) as GatewayMethodAccessPolicy;
    const registry = createGatewayMethodRegistry([
      {
        name: "demo.card.get",
        handler,
        scope: READ_SCOPE,
        owner: { kind: "plugin", pluginId: "demo" },
        access,
      },
    ]);
    const stored = registry.getAccessPolicy("demo.card.get");

    expect(reads).toEqual({ kind: 1, permission: 1, resolver: 1 });
    expect(() => registry.getAccessPolicy("demo.card.get")).not.toThrow();
    expect(reads).toEqual({ kind: 1, permission: 1, resolver: 1 });
    if (stored?.kind !== "resource") {
      throw new Error("expected canonical resource access policy");
    }
    await expect(
      stored.resolveResources({ method: "demo.card.get", params: {}, config: {} }),
    ).rejects.toThrow(/loader-bound plugin namespace/i);
  });

  it("preserves reserved core and aux scopes", () => {
    const registry = createGatewayMethodRegistry([
      {
        name: "config.get",
        handler,
        scope: READ_SCOPE,
        owner: { kind: "core", area: "gateway" },
      },
      {
        name: "exec.approvals.get",
        handler,
        scope: "operator.approvals",
        owner: { kind: "aux", area: "gateway-extra" },
      },
    ]);

    expect(registry.getScope("config.get")).toBe(READ_SCOPE);
    expect(registry.getScope("exec.approvals.get")).toBe("operator.approvals");
  });

  it("defaults handler-only plugin registries to admin scope", () => {
    const descriptors = createPluginGatewayMethodDescriptors({
      gatewayHandlers: { "legacy.ping": handler },
    });

    const registry = createGatewayMethodRegistry(descriptors);

    expect(registry.listMethods()).toEqual(["legacy.ping"]);
    expect(registry.getHandler("legacy.ping")).toBe(handler);
    expect(registry.getScope("legacy.ping")).toBe(ADMIN_SCOPE);
    expect(registry.getAccessPolicy("legacy.ping")).toBeUndefined();
  });
});
