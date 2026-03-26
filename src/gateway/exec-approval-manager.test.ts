import { describe, expect, it } from "vitest";
import { ExecApprovalManager } from "./exec-approval-manager.js";

describe("ExecApprovalManager", () => {
  const minimalRequest = {
    command: "echo hi",
    cwd: "/tmp",
    host: "gateway" as const,
  };

  it("allows registering the same id again after the prior approval resolved (grace window)", async () => {
    const manager = new ExecApprovalManager();
    const id = "71b00ff5-a5af-4ce9-a23f-64fb6b7a2fe1";
    const record1 = manager.create(minimalRequest, 60_000, id);
    const p1 = manager.register(record1, 60_000);
    expect(manager.resolve(id, "allow-once", null)).toBe(true);
    await expect(p1).resolves.toBe("allow-once");

    const record2 = manager.create({ ...minimalRequest, command: "echo two" }, 60_000, id);
    const p2 = manager.register(record2, 60_000);
    expect(manager.resolve(id, "allow-once", null)).toBe(true);
    await expect(p2).resolves.toBe("allow-once");
  });
});
