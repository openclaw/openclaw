import { expect, it } from "vitest";
import { resolveSessionMethodScope } from "./session-method-scopes-base.js";
import { resolveDynamicSessionMutationRequiredScope as scope } from "./session-method-scopes.js";

const target = { key: "agent:main:thread" };
const patchScope = (patch: Record<string, unknown>) =>
  scope("sessions.patch", { ...target, ...patch });
const batchScope = (patch: Record<string, unknown>, extraTarget = {}) =>
  scope("sessions.patchMany", { targets: [{ ...target, ...extraTarget }], patch });

it("keeps explicit restart recovery at write scope", () => {
  expect(scope("sessions.recover")).toBe("operator.write");
});

it("requires admin to create a full-access session", () => {
  expect(scope("sessions.create", { permissionMode: "full" })).toBe("operator.admin");
});

it("requires admin to patch a session to full access", () => {
  expect(patchScope({ permissionMode: "full" })).toBe("operator.admin");
  expect(batchScope({ permissionMode: "full" })).toBe("operator.admin");
});

it("allows session-scoped visibility mutations for single and batch patch", () => {
  const patch = { snoozedUntil: null };
  const visibilityTarget = {
    ...target,
    expectedSessionId: "session-1",
    expectedSidebarRoot: false,
    expectedCategory: null,
    expectedArchived: false,
  };
  for (const [method, params] of [
    ["sessions.patch", { ...visibilityTarget, ...patch }],
    ["sessions.patchMany", { targets: [visibilityTarget], patch }],
  ] as const) {
    expect(resolveSessionMethodScope(method, params)).toBe("operator.sessions.write");
    expect(scope(method, params)).toBe("operator.write");
  }
});

it.each([{ contextWindow: "extended" }, { sandboxMode: null }])(
  "keeps privileged or unknown patch fields admin-scoped %#",
  (patch) => {
    expect(patchScope(patch)).toBe("operator.admin");
  },
);

it("scopes sessions.patchMany from the shared patch only", () => {
  for (const sandboxMode of ["off", null]) {
    expect(batchScope({ sandboxMode }, { expectedSandboxMode: null })).toBe("operator.admin");
  }
  const patch = {
    label: "Renamed",
    icon: "🦞",
    archived: true,
    unread: false,
    model: "openai/gpt-5.6-luna",
    thinkingLevel: "high",
    fastMode: "auto",
  };
  const targetEnvelope = {
    agentId: "main",
    expectedSessionId: "session-1",
    expectedLifecycleRevision: "revision-1",
  };
  expect(batchScope(patch, targetEnvelope)).toBe("operator.write");
  expect(batchScope({ model: null, thinkingLevel: null, fastMode: null })).toBe("operator.write");
  for (const adminPatch of [
    { statusNote: "Working" },
    { thinkingLevel: "high", contextWindow: "extended" },
    { model: "openai/gpt-test-a", fastMode: true, toolOverrides: {} },
    { futureField: true },
  ]) {
    expect(batchScope(adminPatch)).toBe("operator.admin");
  }
  expect(scope("sessions.patchMany")).toBe("operator.write");
  expect(scope("sessions.patchMany", {})).toBe("operator.write");
});

it.each([
  { ...target, autoDevice: true },
  { ...target, profileId: "development", deviceId: "device-1" },
] as const)("classifies dispatch target %j as write-scoped", (params) => {
  expect(scope("sessions.dispatch", params)).toBe("operator.write");
});

it("does not duplicate static method policy from the core descriptor table", () => {
  expect(scope("sessions.groups.put")).toBeUndefined();
  expect(scope("sessions.list")).toBeUndefined();
});
