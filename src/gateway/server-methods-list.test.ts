import { beforeEach, describe, expect, it } from "vitest";
import { GATEWAY_EVENTS } from "./events.js";
import {
  createCoreGatewayMethodDescriptors,
  STARTUP_UNAVAILABLE_GATEWAY_METHODS,
} from "./methods/core-method-policy.js";
import { listGatewayMethods } from "./server-methods-list.js";
import { LEGACY_ADVERTISED_GATEWAY_METHODS } from "./server-methods-list.test-fixtures.js";
import { coreGatewayHandlers } from "./server-methods.js";

describe("listGatewayMethods", () => {
  const voiceSelectionMethods = ["talk.voice.get", "talk.voice.set", "talk.voice.complete"];
  let methods: string[];
  beforeEach(() => {
    methods = listGatewayMethods();
  });
  const descriptors = createCoreGatewayMethodDescriptors(coreGatewayHandlers);
  const descriptor = (name: string) => descriptors.find((entry) => entry.name === name);
  function expectAdvertised(...names: string[]) {
    for (const name of names) {
      expect(methods).toContain(name);
      expect(coreGatewayHandlers[name]).toBeTypeOf("function");
    }
  }

  it.each([
    ["agents.avatar.generate", "operator.admin", { since: "2026.10", controlPlaneWrite: true }],
    ["users.background.get", "operator.read", {}],
    ["users.background.upload", "operator.write", {}],
    ["users.background.remove", "operator.write", {}],
    ["models.authSetApiKey", "operator.admin", { controlPlaneWrite: true }],
  ] as const)("advertises and applies authority policy to %s", (name, scope, policy) => {
    expectAdvertised(name);
    expect(descriptor(name)).toMatchObject({ scope, ...policy });
  });

  it("appends the MCP event catalog with its current-train read policy", () => {
    expect(methods.indexOf("mcp.events.list")).toBeGreaterThanOrEqual(
      LEGACY_ADVERTISED_GATEWAY_METHODS.length,
    );
    expect(coreGatewayHandlers["mcp.events.list"]).toBeTypeOf("function");
    expect(descriptor("mcp.events.list")).toMatchObject({
      scope: "operator.read",
      since: "2026.10",
    });
  });

  it("preserves the frozen legacy advertised method prefix", () => {
    expect(methods.slice(0, LEGACY_ADVERTISED_GATEWAY_METHODS.length)).toEqual(
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
    expectAdvertised("plugins.reload");
    for (const name of ["plugins.reload", "plugins.refresh"]) {
      expect(descriptor(name)).toMatchObject({
        scope: "operator.admin",
        controlPlaneWrite: true,
      });
    }
  });

  it("keeps Claw discovery and Add after model probing without retired task methods", () => {
    expect(methods.some((method) => method.startsWith("tasks."))).toBe(false);
    const clawMethods = [
      "claws.catalog.search",
      "claws.catalog.detail",
      "claws.catalog.preview",
      "claws.add.plan",
      "claws.add.apply",
    ];
    let previous = methods.indexOf("models.probe");
    for (const method of clawMethods) {
      const index = methods.indexOf(method);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
  });

  it("advertises Control UI session pull request detection", () => {
    expect(methods).toContain("controlUi.sessionPullRequests.subscribe");
    expect(methods).toContain("controlUi.sessionPullRequests.checks");
    expect(coreGatewayHandlers["controlUi.sessionPullRequests.checks"]).toBeTypeOf("function");
    expect(GATEWAY_EVENTS).toContain("controlUi.sessionPullRequests.changed");
  });

  it.each([
    ["sessions.files.reveal"],
    ["audit.activity.list", "audit.run.inspect"],
    ["update.hold"],
    ["update.runs.get"],
    ["update.runs.list"],
    voiceSelectionMethods,
  ])("advertises and wires %s", (...names) => expectAdvertised(...names));

  it("keeps deprecated restart preflight compatibility read-only and advertised", () => {
    expectAdvertised("gateway.restart.preflight");
    expect(methods.indexOf("gateway.restart.preflight")).toBe(
      methods.indexOf("gateway.restart.request") - 1,
    );
    expect(descriptor("gateway.restart.preflight")).toMatchObject({
      scope: "operator.read",
      since: "<=2026.7",
    });
    expect(descriptor("gateway.restart.preflight")?.controlPlaneWrite).toBeUndefined();
  });

  it("classifies cron mutations as control-plane writes", () => {
    for (const method of ["cron.add", "cron.update", "cron.remove", "cron.run"]) {
      expect(descriptor(method)).toMatchObject({
        scope: "operator.admin",
        controlPlaneWrite: true,
      });
    }
    for (const method of ["cron.get", "cron.list", "cron.status", "cron.runs", "cron.history"]) {
      expect(descriptor(method)?.controlPlaneWrite).toBeUndefined();
    }
  });

  it.each([
    ["sessions.title.prepare", { scope: "operator.write", controlPlaneWrite: true }],
    ["projects.add", { scope: "operator.write", controlPlaneWrite: true }],
    [
      "projects.searchRemote",
      {
        scope: "operator.read",
        description: "Search GitHub repositories that can be cloned as managed projects.",
      },
    ],
  ] as const)("classifies %s policy", (name, policy) => {
    expect(descriptor(name)).toMatchObject(policy);
  });

  it("registers the hidden node protocol feature publication method", () => {
    expect(coreGatewayHandlers["node.runnerInventory.update"]).toBeTypeOf("function");
    expect(descriptor("node.runnerInventory.update")).toMatchObject({
      scope: "node",
      advertise: false,
    });
  });

  it("advertises session involvement and keeps plugin discovery after public sharing", () => {
    expect(methods).toContain("sessions.setInvolvement");
    const start = methods.indexOf("session.publicShare.set") + 1;
    expect(methods.slice(start, start + 3)).toEqual([
      "plugins.catalog.browse",
      "plugins.catalog.categories",
      "plugins.catalog.get",
    ]);
  });

  it("advertises and wires cloud worker environment methods with their required scopes", () => {
    const cloudMethods = [
      "environments.create",
      "environments.destroy",
      "environments.prepare",
    ] as const;
    for (const method of cloudMethods) {
      expectAdvertised(method);
      expect(STARTUP_UNAVAILABLE_GATEWAY_METHODS).toContain(method);
      expect(descriptor(method)).toMatchObject({
        scope: "operator.admin",
        startup: "unavailable-until-sidecars",
        controlPlaneWrite: true,
      });
    }
    for (const [method, scope, controlPlaneWrite] of sessionEnvironmentMethods) {
      expectAdvertised(method);
      expect(descriptor(method)).toMatchObject({ scope, since: "2026.9" });
      expect(descriptor(method)?.controlPlaneWrite).toBe(controlPlaneWrite);
    }
  });
});
