/** Tests authority policies on registered Gateway methods. */
import { describe, expect, it } from "vitest";
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

  it("appends the MCP event catalog with its current-train read policy", () => {
    const advertised = listGatewayMethods();
    expect(advertised.indexOf("mcp.events.list")).toBeGreaterThanOrEqual(
      LEGACY_ADVERTISED_GATEWAY_METHODS.length,
    );
    expect(coreGatewayHandlers["mcp.events.list"]).toBeTypeOf("function");
    expect(
      createCoreGatewayMethodDescriptors(coreGatewayHandlers).find(
        (descriptor) => descriptor.name === "mcp.events.list",
      ),
    ).toMatchObject({ scope: "operator.read", since: "2026.10" });
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

  it("advertises node plugin tool catalog updates", () => {
    expect(listGatewayMethods()).toContain("node.pluginTools.update");
  });

  it("advertises node skill catalog updates", () => {
    expect(listGatewayMethods()).toContain("node.skills.update");
  });

  it("advertises unified approval lookup, history, and resolution", () => {
    expect(listGatewayMethods()).toContain("approval.get");
    expect(listGatewayMethods()).toContain("approval.history");
    expect(listGatewayMethods()).toContain("approval.resolve");
  });

  it("keeps Claw discovery and Add after model probing without changing the legacy prefix", () => {
    const methods = listGatewayMethods();
    expect(methods.slice(0, LEGACY_ADVERTISED_GATEWAY_METHODS.length)).toEqual(
      LEGACY_ADVERTISED_GATEWAY_METHODS,
    );
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

  it("advertises ClawHub skill trust methods", () => {
    const methods = listGatewayMethods();
    expect(methods).toContain("skills.securityVerdicts");
    expect(methods).toContain("skills.skillCard");
  });

  it("advertises Control UI GitHub previews", () => {
    expect(listGatewayMethods()).toContain("controlUi.githubPreview");
  });

  it("advertises Control UI session pull request detection", () => {
    expect(listGatewayMethods()).toContain("controlUi.sessionPullRequests.subscribe");
    expect(listGatewayMethods()).toContain("controlUi.sessionPullRequests.checks");
    expect(coreGatewayHandlers["controlUi.sessionPullRequests.checks"]).toBeTypeOf("function");
    expect(GATEWAY_EVENTS).toContain("controlUi.sessionPullRequests.changed");
  });

  it("advertises explicit session viewer presence", () => {
    expect(listGatewayMethods()).toContain("sessions.viewers.set");
  });

  it("advertises session workspace reveal", () => {
    expect(listGatewayMethods()).toContain("sessions.files.reveal");
    expect(coreGatewayHandlers["sessions.files.reveal"]).toBeTypeOf("function");
  });

  it("advertises the versioned activity audit method", () => {
    expect(listGatewayMethods()).toContain("audit.activity.list");
    expect(coreGatewayHandlers["audit.activity.list"]).toBeTypeOf("function");
    expect(listGatewayMethods()).toContain("audit.run.inspect");
    expect(coreGatewayHandlers["audit.run.inspect"]).toBeTypeOf("function");
  });

  it.each(["update.hold", "update.runs.get", "update.runs.list"])("advertises %s", (method) => {
    expect(listGatewayMethods()).toContain(method);
    expect(coreGatewayHandlers[method]).toBeTypeOf("function");
  });

  it("keeps deprecated restart preflight compatibility read-only and advertised", () => {
    const methods = listGatewayMethods();
    const descriptor = createCoreGatewayMethodDescriptors(coreGatewayHandlers).find(
      (candidate) => candidate.name === "gateway.restart.preflight",
    );

    expect(methods).toContain("gateway.restart.preflight");
    expect(methods.indexOf("gateway.restart.preflight")).toBe(
      methods.indexOf("gateway.restart.request") - 1,
    );
    expect(coreGatewayHandlers["gateway.restart.preflight"]).toBeTypeOf("function");
    expect(descriptor).toMatchObject({
      name: "gateway.restart.preflight",
      scope: "operator.read",
      since: "<=2026.7",
    });
    expect(descriptor?.controlPlaneWrite).toBeUndefined();
  });

  it("classifies cron mutations as control-plane writes", () => {
    const descriptors = createCoreGatewayMethodDescriptors(coreGatewayHandlers);

    for (const method of ["cron.add", "cron.update", "cron.remove", "cron.run"]) {
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

  it("registers the hidden node protocol feature publication method", () => {
    const descriptor = createCoreGatewayMethodDescriptors(coreGatewayHandlers).find(
      (candidate) => candidate.name === "node.runnerInventory.update",
    );

    expect(coreGatewayHandlers["node.runnerInventory.update"]).toBeTypeOf("function");
    expect(descriptor).toMatchObject({
      name: "node.runnerInventory.update",
      scope: "node",
      advertise: false,
    });
  });

  it("preserves the legacy advertised method order", () => {
    const methods = listGatewayMethods();
    expect(methods.slice(0, 5)).toEqual([
      "health",
      "diagnostics.stability",
      "doctor.memory.status",
      "doctor.memory.dreamDiary",
      "doctor.memory.backfillDreamDiary",
    ]);
    expect(methods.slice(31, 36)).toEqual([
      "exec.approvals.get",
      "exec.approvals.set",
      "exec.approvals.node.get",
      "exec.approvals.node.set",
      "exec.approval.get",
    ]);
    expect(methods).toContain("tts.speak");
    expect(methods.indexOf("approval.get")).toBeGreaterThan(methods.indexOf("tts.speak"));
    expect(methods.indexOf("approval.resolve")).toBe(methods.indexOf("approval.get") + 1);
    expect(methods.indexOf("audit.run.inspect")).toBe(methods.indexOf("hooks.status") + 1);
    expect(methods.indexOf("sessions.patchMany")).toBe(methods.indexOf("audit.run.inspect") + 1);
    expect(methods.indexOf("update.hold")).toBe(methods.indexOf("sessions.patchMany") + 1);
    expect(methods.indexOf("sessions.catalog.startTerminal")).toBe(
      methods.indexOf("update.hold") + 1,
    );
    expect(methods.indexOf("worker.desktop.observe")).toBe(
      methods.indexOf("sessions.catalog.startTerminal") + 1,
    );
    expect(methods.indexOf("projects.list")).toBe(methods.indexOf("worker.desktop.observe") + 1);
    expect(methods.indexOf("projects.register")).toBe(methods.indexOf("projects.list") + 1);
    expect(methods.indexOf("projects.remove")).toBe(methods.indexOf("projects.register") + 1);
    expect(methods.indexOf("worker.desktop.launch")).toBe(methods.indexOf("projects.remove") + 1);
    expect(methods.indexOf("secrets.store.list")).toBe(
      methods.indexOf("worker.desktop.launch") + 1,
    );
    expect(methods.indexOf("secrets.store.set")).toBe(methods.indexOf("secrets.store.list") + 1);
    expect(methods.indexOf("secrets.store.delete")).toBe(methods.indexOf("secrets.store.set") + 1);
    expect(methods.indexOf("users.prefs.get")).toBe(methods.indexOf("secrets.store.delete") + 1);
    expect(methods.indexOf("users.prefs.set")).toBe(methods.indexOf("users.prefs.get") + 1);
    expect(methods.indexOf("projects.add")).toBe(methods.indexOf("users.prefs.set") + 1);
    expect(methods.indexOf("projects.searchRemote")).toBe(methods.indexOf("projects.add") + 1);
    expect(methods.indexOf("desktop.observe")).toBe(methods.indexOf("projects.searchRemote") + 1);
    expect(methods.indexOf("desktop.launch")).toBe(methods.indexOf("desktop.observe") + 1);
    expect(methods.indexOf("device.scopes.requestUpgrade")).toBe(
      methods.indexOf("desktop.launch") + 1,
    );
    expect(methods.indexOf("device.scopes.waitUpgrade")).toBe(
      methods.indexOf("device.scopes.requestUpgrade") + 1,
    );
    expect(methods.indexOf("portal.list")).toBe(methods.indexOf("device.scopes.waitUpgrade") + 1);
    expect(methods.indexOf("portal.open")).toBe(methods.indexOf("portal.list") + 1);
    expect(methods.indexOf("portal.close")).toBe(methods.indexOf("portal.open") + 1);
    expect(methods.indexOf("sessions.move")).toBe(methods.indexOf("portal.close") + 1);
    expect(methods.indexOf("sessions.assignOwner")).toBe(methods.indexOf("sessions.move") + 1);
    expect(methods.indexOf("progressCard.get")).toBe(methods.indexOf("sessions.assignOwner") + 1);
    expect(methods).toContain("sessions.setInvolvement");
    expect(methods.indexOf("progressCard.put")).toBe(methods.indexOf("progressCard.get") + 1);
    expect(methods.indexOf("session.members.listEvidence")).toBe(
      methods.indexOf("diagnostics.lanes") + 1,
    );
    expect(methods.indexOf("plugins.catalog.browse")).toBe(
      methods.indexOf("session.publicShare.set") + 1,
    );
    expect(methods.indexOf("plugins.catalog.categories")).toBe(
      methods.indexOf("plugins.catalog.browse") + 1,
    );
    expect(methods.indexOf("plugins.catalog.get")).toBe(
      methods.indexOf("plugins.catalog.categories") + 1,
    );
  });

  it("advertises API-key saving as an administrator control-plane write", () => {
    expect(listGatewayMethods()).toContain("models.authSetApiKey");
    expect(coreGatewayHandlers["models.authSetApiKey"]).toBeTypeOf("function");
    expect(
      createCoreGatewayMethodDescriptors(coreGatewayHandlers).find(
        (descriptor) => descriptor.name === "models.authSetApiKey",
      ),
    ).toMatchObject({ scope: "operator.admin", controlPlaneWrite: true });
  });

  it("advertises the versioned Talk session RPCs", () => {
    const methods = listGatewayMethods();
    expect(methods).toContain("talk.client.create");
    expect(methods).toContain("talk.client.transcript");
    expect(methods).toContain("talk.client.close");
    expect(methods).toContain("talk.client.toolCall");
    expect(methods).toContain("talk.client.steer");
    expect(methods).toContain("talk.session.create");
    expect(methods).toContain("talk.session.appendAudio");
    expect(methods).toContain("talk.session.cancelOutput");
    expect(methods).toContain("talk.session.acknowledgeMark");
    expect(methods).toContain("talk.session.submitToolResult");
    expect(methods).toContain("talk.session.steer");
    expect(methods).toContain("talk.session.close");
    for (const method of voiceSelectionMethods) {
      expect(methods).toContain(method);
      expect(coreGatewayHandlers[method]).toBeTypeOf("function");
    }
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
