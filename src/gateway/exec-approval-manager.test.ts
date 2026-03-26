import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecApprovalManager, RESOLVED_ENTRY_GRACE_MS } from "./exec-approval-manager.js";

describe("ExecApprovalManager", () => {
  const minimalRequest = {
    command: "echo hi",
    cwd: "/tmp",
    host: "gateway" as const,
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects re-registering the same id while the prior resolution is in the grace window", () => {
    vi.useFakeTimers();
    const manager = new ExecApprovalManager();
    const id = "71b00ff5-a5af-4ce9-a23f-64fb6b7a2fe1";
    const record1 = manager.create(minimalRequest, 60_000, id);
    void manager.register(record1, 60_000);
    expect(manager.resolve(id, "allow-once", null)).toBe(true);

    const record2 = manager.create({ ...minimalRequest, command: "echo two" }, 60_000, id);
    expect(() => manager.register(record2, 60_000)).toThrow(
      /still reserved for previous resolution/,
    );
  });

  it("allows registering the same id again after the grace window removes the resolved entry", async () => {
    vi.useFakeTimers();
    const manager = new ExecApprovalManager();
    const id = "71b00ff5-a5af-4ce9-a23f-64fb6b7a2fe1";
    const record1 = manager.create(minimalRequest, 60_000, id);
    const p1 = manager.register(record1, 60_000);
    expect(manager.resolve(id, "allow-once", null)).toBe(true);
    await expect(p1).resolves.toBe("allow-once");

    await vi.advanceTimersByTimeAsync(RESOLVED_ENTRY_GRACE_MS + 1);

    const record2 = manager.create({ ...minimalRequest, command: "echo two" }, 60_000, id);
    const p2 = manager.register(record2, 60_000);
    expect(manager.resolve(id, "allow-once", null)).toBe(true);
    await expect(p2).resolves.toBe("allow-once");
  });

  it("keeps late awaitDecision tied to the resolved entry when the id is not reused early", async () => {
    vi.useFakeTimers();
    const manager = new ExecApprovalManager();
    const id = "71b00ff5-a5af-4ce9-a23f-64fb6b7a2fe2";
    const record1 = manager.create(minimalRequest, 60_000, id);
    void manager.register(record1, 60_000);
    expect(manager.resolve(id, "allow-once", null)).toBe(true);

    const late = manager.awaitDecision(id);
    expect(late).not.toBeNull();
    await expect(late!).resolves.toBe("allow-once");
  });
});
