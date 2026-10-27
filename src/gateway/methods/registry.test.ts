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
    const sessionAccess = { mode: "write" as const, allowOwnSessionScope: true, requiredTool: "x" };
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
      createGatewayMethodRegistry([core("same"), core("same", { scope: WRITE_SCOPE })]),
    ).toThrow("gateway method already registered: same");
  });

  it("rejects unknown core handlers", () => {
    for (const method of "claws.status claws.update.apply claws.remove.apply".split(" ")) {
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
    expect(registry.getScope(name)).toBe(ADMIN_SCOPE);
    expect(registry.requiresAuthenticatedProfile(name)).toBe(true);
    expect(registry.descriptors()[0]?.owner).toEqual({ kind: "plugin", pluginId: "demo" });
  });

  it("classifies every core method and defaults non-core owners fail-closed", () => {
    const coreDescriptors = createCoreGatewayMethodDescriptors(
      Object.fromEntries(listCoreGatewayMethodNames().map((name) => [name, handler])),
    );
    const registry = createGatewayMethodRegistry([
      ...coreDescriptors,
      core("aux.approvals", { scope: "operator.approvals", owner: { kind: "aux", area: "test" } }),
    ]);
    expect(registry.getScope("config.get")).toBe(READ_SCOPE);
    expect(registry.getScope("aux.approvals")).toBe("operator.approvals");
    expect(registry.isControlPlaneWrite("claws.add.apply")).toBe(true);
    expect(registry.listMethods()).toContain("config.openFile");
    expect(registry.listAdvertisedMethods()).not.toContain("config.openFile");
    for (const descriptor of coreDescriptors) {
      expect(["independent", "required"], descriptor.name).toContain(descriptor.profileAccess);
      expect(registry.requiresAuthenticatedProfile(descriptor.name), descriptor.name).toBe(
        descriptor.profileAccess === "required",
      );
    }
    const expectProfile = (methods: string[], required: boolean) => {
      for (const method of methods) {
        expect(registry.requiresAuthenticatedProfile(method), method).toBe(required);
      }
    };
    // Profile accent projection must wait for pending GitHub identity sync.
    expectProfile(
      "users.self talk.config talk.voice.get talk.voice.set agent chat.history sessions.list openclaw.chat projects.list aux.approvals".split(
        " ",
      ),
      true,
    );
    expectProfile(
      "status approval.get approval.history board.data.read board.prompt.authorize talk.client.create talk.session.steer wake".split(
        " ",
      ),
      false,
    );
    expectProfile(listCoreGatewayMethodNames().filter(isSessionProfileDependentMethod), true);
  });
});
