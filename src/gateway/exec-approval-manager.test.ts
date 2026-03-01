import { describe, expect, it, vi } from "vitest";
import { ExecApprovalManager } from "./exec-approval-manager.js";

const TIMEOUT_MS = 60_000;

describe("ExecApprovalManager", () => {
  it("interrupt resolves with interrupted and record is updated", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, TIMEOUT_MS, "id-1");
    const promise = manager.register(record, TIMEOUT_MS);

    const ok = manager.interrupt("id-1", "operator");
    expect(ok).toBe(true);

    const decision = await promise;
    expect(decision).toBe("interrupted");

    const snapshot = manager.getSnapshot("id-1");
    expect(snapshot?.decision).toBe("interrupted");
    expect(snapshot?.resolvedBy).toBe("operator");
  });

  it("interrupt returns false for unknown id", () => {
    const manager = new ExecApprovalManager();
    expect(manager.interrupt("unknown")).toBe(false);
  });

  it("pause sets state to paused", () => {
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, TIMEOUT_MS, "id-pause");
    void manager.register(record, TIMEOUT_MS);

    expect(manager.pause("id-pause")).toBe(true);
    const snapshot = manager.getSnapshot("id-pause");
    expect(snapshot?.state).toBe("paused");
  });

  it("resume sets state to resumed only when state is paused", () => {
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, TIMEOUT_MS, "id-resume");
    void manager.register(record, TIMEOUT_MS);
    manager.pause("id-resume");

    expect(manager.resume("id-resume")).toBe(true);
    const snapshot = manager.getSnapshot("id-resume");
    expect(snapshot?.state).toBe("resumed");
  });

  it("resume returns false and leaves state unchanged when not paused", () => {
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, TIMEOUT_MS, "id-resume-pending");
    void manager.register(record, TIMEOUT_MS);
    expect(manager.getSnapshot("id-resume-pending")?.state).toBe("pending");

    expect(manager.resume("id-resume-pending")).toBe(false);
    expect(manager.getSnapshot("id-resume-pending")?.state).toBe("pending");
  });

  it("pause then resume then resolve allows decision to complete", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, TIMEOUT_MS, "id-chain");
    const promise = manager.register(record, TIMEOUT_MS);

    manager.pause("id-chain");
    expect(manager.getSnapshot("id-chain")?.state).toBe("paused");

    manager.resume("id-chain");
    expect(manager.getSnapshot("id-chain")?.state).toBe("resumed");

    manager.resolve("id-chain", "allow-once", "user");
    const decision = await promise;
    expect(decision).toBe("allow-once");
  });

  it("create includes riskLevel and workflow in request", () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "rm -rf /",
        riskLevel: "high",
        workflow: "policy-1",
      },
      TIMEOUT_MS,
      "id-risk",
    );
    expect(record.request.riskLevel).toBe("high");
    expect(record.request.workflow).toBe("policy-1");
  });

  it("interrupt returns false when already resolved", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, TIMEOUT_MS, "id-done");
    void manager.register(record, TIMEOUT_MS);
    manager.resolve("id-done", "deny", "user");

    await vi
      .waitFor(
        () => {
          if (manager.getSnapshot("id-done") !== null) {
            throw new Error("waiting for entry removal");
          }
        },
        { timeout: 500 },
      )
      .catch(() => {});

    // After grace period the entry may be removed; interrupt on non-pending id returns false
    const record2 = manager.create({ command: "echo two" }, TIMEOUT_MS, "id-two");
    void manager.register(record2, TIMEOUT_MS);
    manager.resolve("id-two", "allow-once");
    expect(manager.interrupt("id-two")).toBe(false);
  });
});
