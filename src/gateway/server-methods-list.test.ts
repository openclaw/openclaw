import { expect, it } from "vitest";
import {
  createCoreGatewayMethodDescriptors,
  STARTUP_UNAVAILABLE_GATEWAY_METHODS,
} from "./methods/core-method-policy.js";
import { listGatewayMethods } from "./server-methods-list.js";
import { LEGACY_ADVERTISED_GATEWAY_METHODS } from "./server-methods-list.test-fixtures.js";
import { coreGatewayHandlers } from "./server-methods.js";

const descriptors = createCoreGatewayMethodDescriptors(coreGatewayHandlers);
const descriptor = (name: string) => descriptors.find((entry) => entry.name === name);

it.each([
  ["agents.avatar.generate", "operator.admin", { since: "2026.10", controlPlaneWrite: true }],
  [
    "models.authSetApiKey plugins.reload plugins.refresh cron.add cron.update cron.remove cron.run",
    "operator.admin",
    { controlPlaneWrite: true },
  ],
  ["sessions.title.prepare projects.add", "operator.write", { controlPlaneWrite: true }],
  ["projects.searchRemote", "operator.read", {}],
  ["node.runnerInventory.update", "node", { advertise: false }],
  ["mcp.events.list", "operator.read", { since: "2026.10" }],
  ["sessions.groups.create", "operator.write", { since: "2026.10" }],
  ["gateway.restart.preflight", "operator.read", { since: "<=2026.7" }],
  [
    "environments.create environments.destroy environments.prepare",
    "operator.admin",
    { startup: "unavailable-until-sidecars", controlPlaneWrite: true },
  ],
  ["environments.session.status", "operator.read", { since: "2026.9" }],
  [
    "environments.session.create environments.session.destroy",
    "operator.admin",
    { since: "2026.9", controlPlaneWrite: true },
  ],
  ["environments.session.exec", "operator.admin", { since: "2026.9" }],
] as const)("applies discovery and authority policy to %s", (names, scope, policy) => {
  const methods = listGatewayMethods();
  for (const name of names.split(" ")) {
    expect(coreGatewayHandlers[name]).toBeTypeOf("function");
    expect(descriptor(name)).toMatchObject({ scope, ...policy });
    if ("startup" in policy) {
      expect(STARTUP_UNAVAILABLE_GATEWAY_METHODS).toContain(name);
    }
    if (name !== "node.runnerInventory.update") {
      expect(methods).toContain(name);
    }
  }
});

it("keeps read-only methods outside the control-plane write budget", () => {
  for (const name of [
    "gateway.restart.preflight",
    "cron.get",
    "cron.list",
    "cron.status",
    "cron.runs",
    "cron.history",
    "environments.session.status",
    "environments.session.exec",
  ]) {
    expect(descriptor(name)?.controlPlaneWrite).toBeUndefined();
  }
});

it("preserves the legacy advertised prefix and appends the MCP catalog", () => {
  const methods = listGatewayMethods();
  expect(methods.slice(0, LEGACY_ADVERTISED_GATEWAY_METHODS.length)).toEqual(
    LEGACY_ADVERTISED_GATEWAY_METHODS,
  );
  expect(methods.indexOf("mcp.events.list")).toBeGreaterThanOrEqual(
    LEGACY_ADVERTISED_GATEWAY_METHODS.length,
  );
});

it.each([
  "users.background.get",
  "users.background.upload",
  "users.background.remove",
  "controlUi.sessionPullRequests.checks",
  "update.runs.get",
  "update.runs.list",
  "talk.voice.get",
  "talk.voice.set",
  "talk.voice.complete",
  "sessions.setInvolvement",
])("advertises and wires %s", (name) => {
  expect(listGatewayMethods()).toContain(name);
  expect(coreGatewayHandlers[name]).toBeTypeOf("function");
});
