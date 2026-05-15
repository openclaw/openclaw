import { describe, expect, it } from "vitest";
import { ADMIN_SCOPE, READ_SCOPE, WRITE_SCOPE } from "../operator-scopes.js";
import type { GatewayRequestHandler } from "../server-methods/types.js";
import {
  createGatewayMethodRegistry,
  createPluginGatewayMethodDescriptors,
  createPluginGatewayMethodDescriptor,
  resolveLegacyGatewayMethodScope,
} from "./registry.js";

const handler: GatewayRequestHandler = ({ respond }) => respond(true, { ok: true });

describe("gateway method registry", () => {
  it("indexes handlers, scopes, startup state, and control-plane metadata", () => {
    const registry = createGatewayMethodRegistry([
      {
        name: "example.read",
        handler,
        scope: READ_SCOPE,
        owner: { kind: "core", area: "test" },
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
    expect(registry.isStartupUnavailable("example.write")).toBe(true);
    expect(registry.isControlPlaneWrite("example.write")).toBe(true);
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

  it("accepts legacy plugin registries without descriptor metadata", () => {
    const descriptors = createPluginGatewayMethodDescriptors({
      gatewayHandlers: { "legacy.ping": handler },
      gatewayMethodScopes: { "legacy.ping": READ_SCOPE },
    });

    const registry = createGatewayMethodRegistry(descriptors);

    expect(registry.listMethods()).toEqual(["legacy.ping"]);
    expect(registry.getHandler("legacy.ping")).toBe(handler);
    expect(registry.getScope("legacy.ping")).toBe(READ_SCOPE);
  });

  it("keeps legacy scope metadata available during migration", () => {
    expect(resolveLegacyGatewayMethodScope("health")).toBe(READ_SCOPE);
    expect(resolveLegacyGatewayMethodScope("config.apply")).toBe(ADMIN_SCOPE);
    expect(resolveLegacyGatewayMethodScope("node.event")).toBe("node");
  });
});
