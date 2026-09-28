import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

function expectInvalidWorkerRuns(workerRuns: Record<string, unknown>, field: string) {
  const result = validateConfigObject({ nodeHost: { workerRuns } });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.issues.some((issue) => issue.path === `nodeHost.workerRuns.${field}`)).toBe(true);
  }
}

describe("node agent-runs config", () => {
  it("keeps Claude node execution disabled unless explicitly enabled", () => {
    const result = validateConfigObject({ nodeHost: {} });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.nodeHost?.agentRuns?.claude?.enabled).toBeUndefined();
    }
  });

  it("accepts explicit Claude enablement", () => {
    expect(
      validateConfigObject({ nodeHost: { agentRuns: { claude: { enabled: true } } } }).ok,
    ).toBe(true);
  });

  it("rejects non-boolean Claude enablement", () => {
    const result = validateConfigObject({
      nodeHost: { agentRuns: { claude: { enabled: "yes" } } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((issue) => issue.path === "nodeHost.agentRuns.claude.enabled"),
      ).toBe(true);
    }
  });

  it("accepts worker session hosting enablement", () => {
    expect(validateConfigObject({ nodeHost: { workerRuns: { enabled: true } } }).ok).toBe(true);
  });

  it("keeps direct worker execution as the implicit default", () => {
    const result = validateConfigObject({ nodeHost: { workerRuns: {} } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.nodeHost?.workerRuns?.isolation).toBeUndefined();
    }
  });

  it.each(["none", "container"])("accepts worker session isolation=%s", (isolation) => {
    expect(validateConfigObject({ nodeHost: { workerRuns: { isolation } } }).ok).toBe(true);
  });

  it.each(["docker", true])("rejects invalid worker session isolation=%j", (isolation) => {
    expectInvalidWorkerRuns({ isolation }, "isolation");
  });

  it("accepts a worker container image", () => {
    expect(
      validateConfigObject({ nodeHost: { workerRuns: { containerImage: "node:22-slim" } } }).ok,
    ).toBe(true);
  });

  it.each(["   ", 22])("rejects invalid worker container image=%j", (containerImage) => {
    expectInvalidWorkerRuns({ containerImage }, "containerImage");
  });

  it.each([1, 1024])("accepts worker session hosting capacity=%s", (capacity) => {
    expect(validateConfigObject({ nodeHost: { workerRuns: { capacity } } }).ok).toBe(true);
  });

  it.each([0, 1.5, 1025])("rejects invalid worker session hosting capacity=%s", (capacity) => {
    expectInvalidWorkerRuns({ capacity }, "capacity");
  });

  it("rejects non-boolean worker session hosting enablement", () => {
    expectInvalidWorkerRuns({ enabled: "yes" }, "enabled");
  });
});
