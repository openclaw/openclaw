/** Tests authority policies on registered Gateway methods. */
import { describe, expect, it } from "vitest";
import {
  createCoreGatewayMethodDescriptors,
  STARTUP_UNAVAILABLE_GATEWAY_METHODS,
} from "./methods/core-method-policy.js";
import { GATEWAY_EVENTS, listGatewayMethods } from "./server-methods-list.js";
import { LEGACY_ADVERTISED_GATEWAY_METHODS } from "./server-methods-list.test-fixtures.js";
import { coreGatewayHandlers } from "./server-methods.js";

describe("listGatewayMethods", () => {
  it("advertises private backgrounds with personal read/write scopes", () => {
    const descriptors = createCoreGatewayMethodDescriptors(coreGatewayHandlers);
    for (const { name, scope } of [
      { name: "users.background.get", scope: "operator.read" },
      { name: "users.background.upload", scope: "operator.write" },
      { name: "users.background.remove", scope: "operator.write" },
    ]) {
      expect(listGatewayMethods()).toContain(name);
      expect(coreGatewayHandlers[name]).toBeTypeOf("function");
      expect(descriptors.find((descriptor) => descriptor.name === name)).toMatchObject({ scope });
    }
  });

  it("preserves the frozen legacy advertised method prefix", () => {
    expect(listGatewayMethods().slice(0, LEGACY_ADVERTISED_GATEWAY_METHODS.length)).toEqual(
      LEGACY_ADVERTISED_GATEWAY_METHODS,
    );
  });

  const sessionEnvironmentMethods = [
    ["environments.session.status", "operator.read", undefined],
    ["environments.session.create", "operator.admin", true],
    ["environments.session.destroy", "operator.admin", true],
    ["environments.session.exec", "operator.admin", undefined],
  ] as const;

  it("advertises plugin reload with admin mutation policy and generation invalidation", () => {
    expect(GATEWAY_EVENTS).toContain("plugins.changed");
    expect(listGatewayMethods()).toContain("plugins.reload");
    expect(coreGatewayHandlers["plugins.reload"]).toBeTypeOf("function");
    const descriptors = createCoreGatewayMethodDescriptors(coreGatewayHandlers);
    for (const name of ["plugins.reload", "plugins.refresh"]) {
      expect(descriptors.find((descriptor) => descriptor.name === name)).toMatchObject({
        scope: "operator.admin",
        controlPlaneWrite: true,
      });
    }
  });

  it("classifies cron mutations as control-plane writes", () => {
    const descriptors = createCoreGatewayMethodDescriptors(coreGatewayHandlers);

    for (const method of [
      "cron.add",
      "cron.update",
      "cron.remove",
      "cron.run",
      "claws.monitors",
      "claws.removalJournal",
    ]) {
      expect(descriptors.find((descriptor) => descriptor.name === method)).toMatchObject({
        name: method,
        scope: "operator.admin",
        controlPlaneWrite: true,
      });
    }
    for (const method of ["cron.get", "cron.list", "cron.status", "cron.runs", "cron.history"]) {
      expect(
        descriptors.find((descriptor) => descriptor.name === method)?.controlPlaneWrite,
      ).toBeUndefined();
    }
  });

  it("rate-limits speculative inference under operator write authority", () => {
    const descriptors = createCoreGatewayMethodDescriptors(coreGatewayHandlers);
    expect(
      descriptors.find((descriptor) => descriptor.name === "sessions.title.prepare"),
    ).toMatchObject({
      scope: "operator.write",
      controlPlaneWrite: true,
    });
  });

  it("advertises and wires cloud worker environment methods with their required scopes", () => {
    const methods = [
      "environments.create",
      "environments.destroy",
      "environments.prepare",
    ] as const;
    const advertisedMethods = listGatewayMethods();
    const descriptors = createCoreGatewayMethodDescriptors(coreGatewayHandlers);

    for (const method of methods) {
      expect(advertisedMethods).toContain(method);
      expect(coreGatewayHandlers[method]).toEqual(expect.any(Function));
      expect(STARTUP_UNAVAILABLE_GATEWAY_METHODS).toContain(method);
      expect(descriptors.find((descriptor) => descriptor.name === method)).toMatchObject({
        name: method,
        scope: "operator.admin",
        startup: "unavailable-until-sidecars",
        controlPlaneWrite: true,
      });
    }
    for (const [method, scope, controlPlaneWrite] of sessionEnvironmentMethods) {
      expect(advertisedMethods).toContain(method);
      expect(coreGatewayHandlers[method]).toBeTypeOf("function");
      const descriptor = descriptors.find((candidate) => candidate.name === method);
      expect(descriptor).toMatchObject({ name: method, scope, since: "2026.9" });
      expect(descriptor?.controlPlaneWrite).toBe(controlPlaneWrite);
    }
  });

  it("classifies project cloning as a described control-plane write", () => {
    const descriptors = createCoreGatewayMethodDescriptors(coreGatewayHandlers);

    expect(descriptors.find((descriptor) => descriptor.name === "projects.add")).toMatchObject({
      scope: "operator.write",
      controlPlaneWrite: true,
    });
    expect(
      descriptors.find((descriptor) => descriptor.name === "projects.searchRemote"),
    ).toMatchObject({
      scope: "operator.read",
      description: "Search GitHub repositories that can be cloned as managed projects.",
    });
  });
});
