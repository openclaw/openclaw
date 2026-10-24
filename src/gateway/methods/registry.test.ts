import { describe, expect, it } from "vitest";
import { ADMIN_SCOPE, READ_SCOPE, WRITE_SCOPE } from "../operator-scopes.js";
import type { GatewayRequestHandler } from "../server-methods/types.js";
import { isSessionProfileDependentMethod } from "../session-method-policy.js";
import { listCoreGatewayMethodNames } from "./core-method-policy.js";
import {
  createPluginGatewayMethodDescriptor,
  type GatewayMethodDescriptorInput,
} from "./descriptor.js";
import { createCoreGatewayMethodDescriptors, createGatewayMethodRegistry } from "./registry.js";

const handler: GatewayRequestHandler = ({ respond }) => respond(true, { ok: true });
const core = (
  name: string,
  overrides: Partial<GatewayMethodDescriptorInput> = {},
): GatewayMethodDescriptorInput => ({
  name,
  handler,
  scope: READ_SCOPE,
  owner: { kind: "core", area: "test" },
  ...overrides,
});

describe("gateway method registry", () => {
  it("requires a profile for session-scoped plugin and core methods", () => {
    const sessionAccess = {
      mode: "write" as const,
      allowOwnSessionScope: true,
      requiredTool: "example",
    };
    const plugin = createPluginGatewayMethodDescriptor({
      pluginId: "example",
      name: "example.session",
      handler,
      scope: WRITE_SCOPE,
      sessionAccess,
    });
    const registry = createGatewayMethodRegistry([
      plugin,
      core("core.session", { scope: WRITE_SCOPE, sessionAccess }),
    ]);
    expect(registry.requiresAuthenticatedProfile("example.session")).toBe(true);
    expect(registry.requiresAuthenticatedProfile("core.session")).toBe(true);
    expect(registry.getSessionAccess?.("example.session")).toEqual(sessionAccess);
    for (const invalid of [
      { profileAccess: "independent" },
      { scope: READ_SCOPE },
      { scope: "operator.sessions.write" },
    ] satisfies Partial<GatewayMethodDescriptorInput>[]) {
      expect(() => createGatewayMethodRegistry([{ ...plugin, ...invalid }])).toThrow(
        "session-scoped gateway methods require operator.write and an authenticated profile",
      );
    }
  });
  it.each(["enumerable", "non-enumerable", "inherited"])("indexes %s metadata", (properties) => {
    const writeDescriptor = core("example.write", { scope: WRITE_SCOPE });
    const policy = {
      startup: "unavailable-until-sidecars",
      lifetime: "observation",
      controlPlaneWrite: true,
      advertise: false,
    } satisfies Partial<GatewayMethodDescriptorInput>;
    if (properties === "inherited") {
      Object.setPrototypeOf(writeDescriptor, policy);
    } else {
      for (const [key, value] of Object.entries(policy)) {
        Object.defineProperty(writeDescriptor, key, {
          value,
          enumerable: properties === "enumerable",
        });
      }
    }
    const registry = createGatewayMethodRegistry([core("example.read"), writeDescriptor]);
    expect(registry.listMethods()).toEqual(["example.read", "example.write"]);
    expect(registry.listAdvertisedMethods()).toEqual(["example.read"]);
    expect(registry.getHandler("example.read")).toBe(handler);
    expect(registry.getScope("example.write")).toBe(WRITE_SCOPE);
    expect(registry.isStartupUnavailable("example.write")).toBe(true);
    expect(registry.isObservation("example.write")).toBe(true);
    expect(registry.isObservation("example.read")).toBe(false);
    expect(registry.isControlPlaneWrite("example.write")).toBe(true);
  });

  it("rejects duplicate method names", () => {
    expect(() =>
      createGatewayMethodRegistry([
        core("example.duplicate"),
        core("example.duplicate", { scope: WRITE_SCOPE }),
      ]),
    ).toThrow("gateway method already registered: example.duplicate");
  });

  it("rejects unknown core handlers while accepting hidden core methods", () => {
    expect(() => createCoreGatewayMethodDescriptors({ "example.unknown": handler })).toThrow(
      "gateway method handler is missing a descriptor: example.unknown",
    );
    expect(createCoreGatewayMethodDescriptors({ "config.openFile": handler })).toMatchObject([
      { name: "config.openFile", advertise: false, handler },
    ]);
  });

  it("classifies Claw Add as a control-plane write without lifecycle methods", () => {
    const registry = createGatewayMethodRegistry(
      createCoreGatewayMethodDescriptors({ "claws.add.apply": handler }),
    );

    expect(registry.isControlPlaneWrite("claws.add.apply")).toBe(true);
    for (const method of ["claws.status", "claws.update.apply", "claws.remove.apply"]) {
      expect(() => createCoreGatewayMethodDescriptors({ [method]: handler })).toThrow(
        `gateway method handler is missing a descriptor: ${method}`,
      );
    }
  });

  it.each([
    { name: "config.demo", scope: READ_SCOPE },
    { name: "demo.ping", scope: undefined },
  ])("enforces admin scope for plugin $name", ({ name, scope }) => {
    const registry = createGatewayMethodRegistry([
      createPluginGatewayMethodDescriptor({ pluginId: "demo", name, handler, scope }),
    ]);
    expect(registry.listMethods()).toEqual([name]);
    expect(registry.getHandler(name)).toBe(handler);
    expect(registry.getScope(name)).toBe(ADMIN_SCOPE);
    expect(registry.requiresAuthenticatedProfile(name)).toBe(true);
    expect(registry.descriptors()[0]?.owner).toEqual({ kind: "plugin", pluginId: "demo" });
  });

  it("preserves reserved core and aux scopes", () => {
    const registry = createGatewayMethodRegistry([
      core("config.get", { owner: { kind: "core", area: "gateway" } }),
      core("exec.approvals.get", {
        scope: "operator.approvals",
        owner: { kind: "aux", area: "gateway-extra" },
      }),
    ]);
    expect(registry.getScope("config.get")).toBe(READ_SCOPE);
    expect(registry.getScope("exec.approvals.get")).toBe("operator.approvals");
  });

  it("classifies every core method and defaults non-core owners fail-closed", () => {
    const coreDescriptors = createCoreGatewayMethodDescriptors(
      Object.fromEntries(listCoreGatewayMethodNames().map((name) => [name, handler])),
    );
    const registry = createGatewayMethodRegistry([
      ...coreDescriptors,
      core("aux.identity.read", { owner: { kind: "aux", area: "test" } }),
    ]);

    for (const descriptor of coreDescriptors) {
      expect(["independent", "required"], descriptor.name).toContain(descriptor.profileAccess);
      expect(registry.requiresAuthenticatedProfile(descriptor.name), descriptor.name).toBe(
        descriptor.profileAccess === "required",
      );
    }
    expect(registry.requiresAuthenticatedProfile("users.self")).toBe(true);
    expect(registry.requiresAuthenticatedProfile("status")).toBe(false);
    // Profile accent projection must wait for pending GitHub identity sync.
    expect(registry.requiresAuthenticatedProfile("talk.config")).toBe(true);
    expect(registry.requiresAuthenticatedProfile("talk.voice.get")).toBe(true);
    expect(registry.requiresAuthenticatedProfile("talk.voice.set")).toBe(true);
    for (const method of listCoreGatewayMethodNames().filter(isSessionProfileDependentMethod)) {
      expect(registry.requiresAuthenticatedProfile(method), method).toBe(true);
    }
    expect(registry.requiresAuthenticatedProfile("agent")).toBe(true);
    expect(registry.requiresAuthenticatedProfile("chat.history")).toBe(true);
    expect(registry.requiresAuthenticatedProfile("sessions.list")).toBe(true);
    expect(registry.requiresAuthenticatedProfile("openclaw.chat")).toBe(true);
    expect(registry.requiresAuthenticatedProfile("projects.list")).toBe(true);
    expect(registry.requiresAuthenticatedProfile("approval.get")).toBe(false);
    expect(registry.requiresAuthenticatedProfile("approval.history")).toBe(false);
    expect(registry.requiresAuthenticatedProfile("board.data.read")).toBe(false);
    expect(registry.requiresAuthenticatedProfile("board.prompt.authorize")).toBe(false);
    expect(registry.requiresAuthenticatedProfile("talk.client.create")).toBe(false);
    expect(registry.requiresAuthenticatedProfile("talk.session.steer")).toBe(false);
    expect(registry.requiresAuthenticatedProfile("wake")).toBe(false);
    expect(registry.requiresAuthenticatedProfile("aux.identity.read")).toBe(true);
  });
});
