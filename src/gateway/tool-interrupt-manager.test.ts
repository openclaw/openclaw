import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ToolInterruptManager } from "./tool-interrupt-manager.js";

async function createTempInterruptPath() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tool-interrupts-"));
  return path.join(root, "gateway", "tool-interrupts.json");
}

describe("ToolInterruptManager", () => {
  it("stores only token hashes and resumes emitted waits", async () => {
    const filePath = await createTempInterruptPath();
    const manager = new ToolInterruptManager({ filePath });
    await manager.load();

    const emitted = await manager.emit({
      approvalRequestId: "approval-1",
      runId: "run-1",
      sessionKey: "agent:main:main",
      toolCallId: "tool-1",
      interrupt: { type: "approval", reason: "needs human confirmation" },
      timeoutMs: 60_000,
    });

    const token = emitted.requested.resumeToken;
    const waitPromise = emitted.wait;
    const persisted = JSON.parse(await fs.readFile(filePath, "utf-8")) as {
      interrupts?: Record<string, { resumeTokenHash?: string; resumeToken?: string }>;
    };
    const record = persisted.interrupts?.["approval-1"];
    expect(record?.resumeTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record?.resumeToken).toBeUndefined();

    const resumed = await manager.resume({
      approvalRequestId: "approval-1",
      runId: "run-1",
      sessionKey: "agent:main:main",
      toolCallId: "tool-1",
      resumeToken: token,
      result: { ok: true, resumed: "done" },
      resumedBy: "tester",
    });
    expect(resumed.ok).toBe(true);
    if (resumed.ok) {
      expect(resumed.alreadyResolved).toBe(false);
    }
    await expect(waitPromise).resolves.toMatchObject({
      status: "resumed",
      approvalRequestId: "approval-1",
      runId: "run-1",
      sessionKey: "agent:main:main",
      toolCallId: "tool-1",
      resumedBy: "tester",
      result: { ok: true, resumed: "done" },
    });
    const persistedAfterResume = JSON.parse(await fs.readFile(filePath, "utf-8")) as {
      interrupts?: Record<string, { resumeToken?: string }>;
    };
    expect(persistedAfterResume.interrupts?.["approval-1"]?.resumeToken).toBeUndefined();
    manager.stop();
  });

  it("binds resume to run/session/tool identity", async () => {
    const filePath = await createTempInterruptPath();
    const manager = new ToolInterruptManager({ filePath });
    await manager.load();

    const emitted = await manager.emit({
      approvalRequestId: "approval-2",
      runId: "run-2",
      sessionKey: "agent:main:main",
      toolCallId: "tool-2",
      interrupt: { type: "approval" },
      timeoutMs: 60_000,
    });

    const mismatch = await manager.resume({
      approvalRequestId: "approval-2",
      runId: "run-other",
      sessionKey: "agent:main:main",
      toolCallId: "tool-2",
      resumeToken: emitted.requested.resumeToken,
      result: { ok: true },
    });
    expect(mismatch).toMatchObject({
      ok: false,
      code: "binding_mismatch",
    });
    manager.stop();
  });

  it("enforces payload binding using toolName + normalizedArgsHash", async () => {
    const filePath = await createTempInterruptPath();
    const manager = new ToolInterruptManager({ filePath });
    await manager.load();

    const emitted = await manager.emit({
      approvalRequestId: "approval-bind-1",
      runId: "run-2",
      sessionKey: "agent:main:main",
      toolCallId: "tool-2",
      toolName: "browser",
      normalizedArgsHash: "a".repeat(64),
      interrupt: { type: "approval" },
      timeoutMs: 60_000,
    });

    const mismatch = await manager.resume({
      approvalRequestId: "approval-bind-1",
      runId: "run-2",
      sessionKey: "agent:main:main",
      toolCallId: "tool-2",
      toolName: "browser",
      normalizedArgsHash: "b".repeat(64),
      resumeToken: emitted.requested.resumeToken,
      result: { ok: true },
    });
    expect(mismatch).toMatchObject({ ok: false, code: "binding_mismatch" });

    const resumed = await manager.resume({
      approvalRequestId: "approval-bind-1",
      runId: "run-2",
      sessionKey: "agent:main:main",
      toolCallId: "tool-2",
      toolName: "browser",
      normalizedArgsHash: "a".repeat(64),
      resumeToken: emitted.requested.resumeToken,
      result: { ok: true },
      decisionReason: "human approved",
      policyRuleId: "rule-42",
      decisionAtMs: 12345,
      decisionMeta: { ticket: "ABC-1" },
    });
    expect(resumed.ok).toBe(true);

    const snapshot = manager.getSnapshot("approval-bind-1");
    expect(snapshot?.decisionReason).toBe("human approved");
    expect(snapshot?.policyRuleId).toBe("rule-42");
    expect(snapshot?.decisionAtMs).toBe(12345);
    expect(snapshot?.decisionMeta).toEqual({ ticket: "ABC-1" });
    manager.stop();
  });

  it("accepts resume when only one optional payload binding was recorded", async () => {
    const filePath = await createTempInterruptPath();
    const manager = new ToolInterruptManager({ filePath });
    await manager.load();

    const toolOnly = await manager.emit({
      approvalRequestId: "approval-bind-tool-only",
      runId: "run-tool-only",
      sessionKey: "agent:main:main",
      toolCallId: "tool-tool-only",
      toolName: "browser",
      interrupt: { type: "approval" },
      timeoutMs: 60_000,
    });
    const toolOnlyResume = await manager.resume({
      approvalRequestId: "approval-bind-tool-only",
      runId: "run-tool-only",
      sessionKey: "agent:main:main",
      toolCallId: "tool-tool-only",
      toolName: "browser",
      resumeToken: toolOnly.requested.resumeToken,
      result: { ok: true },
    });
    expect(toolOnlyResume).toMatchObject({ ok: true, alreadyResolved: false });

    const argsOnly = await manager.emit({
      approvalRequestId: "approval-bind-args-only",
      runId: "run-args-only",
      sessionKey: "agent:main:main",
      toolCallId: "tool-args-only",
      normalizedArgsHash: "d".repeat(64),
      interrupt: { type: "approval" },
      timeoutMs: 60_000,
    });
    const argsOnlyResume = await manager.resume({
      approvalRequestId: "approval-bind-args-only",
      runId: "run-args-only",
      sessionKey: "agent:main:main",
      toolCallId: "tool-args-only",
      normalizedArgsHash: "d".repeat(64),
      resumeToken: argsOnly.requested.resumeToken,
      result: { ok: true },
    });
    expect(argsOnlyResume).toMatchObject({ ok: true, alreadyResolved: false });
    manager.stop();
  });

  it("allows only one successful resume under double-approve race", async () => {
    const filePath = await createTempInterruptPath();
    const manager = new ToolInterruptManager({ filePath });
    await manager.load();

    const emitted = await manager.emit({
      approvalRequestId: "approval-race-1",
      runId: "run-2",
      sessionKey: "agent:main:main",
      toolCallId: "tool-2",
      interrupt: { type: "approval" },
      timeoutMs: 60_000,
    });

    const [a, b] = await Promise.all([
      manager.resume({
        approvalRequestId: "approval-race-1",
        runId: "run-2",
        sessionKey: "agent:main:main",
        toolCallId: "tool-2",
        resumeToken: emitted.requested.resumeToken,
        result: { winner: "a" },
      }),
      manager.resume({
        approvalRequestId: "approval-race-1",
        runId: "run-2",
        sessionKey: "agent:main:main",
        toolCallId: "tool-2",
        resumeToken: emitted.requested.resumeToken,
        result: { winner: "b" },
      }),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(2);
    const resolved = [a, b].filter((item) => item.ok);
    expect(resolved).toHaveLength(2);
    if (resolved[0] && resolved[1]) {
      expect(
        [resolved[0].alreadyResolved, resolved[1].alreadyResolved].toSorted(
          (x, y) => Number(x) - Number(y),
        ),
      ).toEqual([false, true]);
      expect(resolved[0].waitResult.resumedAtMs).toBe(resolved[1].waitResult.resumedAtMs);
    }
    manager.stop();
  });

  it("reuses the same pending resume token across replayed emits", async () => {
    const filePath = await createTempInterruptPath();
    const manager = new ToolInterruptManager({ filePath });
    await manager.load();

    const first = await manager.emit({
      approvalRequestId: "approval-replay-1",
      runId: "run-replay-1",
      sessionKey: "agent:main:main",
      toolCallId: "tool-replay-1",
      interrupt: { type: "approval" },
      timeoutMs: 60_000,
    });
    const second = await manager.emit({
      approvalRequestId: "approval-replay-1",
      runId: "run-replay-1",
      sessionKey: "agent:main:main",
      toolCallId: "tool-replay-1",
      interrupt: { type: "approval" },
      timeoutMs: 60_000,
    });

    expect(second.created).toBe(false);
    expect(second.requested.resumeToken).toBe(first.requested.resumeToken);
    manager.stop();
  });

  it("lists pending interrupts and preserves resume capability across reload", async () => {
    const filePath = await createTempInterruptPath();
    const manager = new ToolInterruptManager({ filePath });
    await manager.load();

    const emitted = await manager.emit({
      approvalRequestId: "approval-list-1",
      runId: "run-list-1",
      sessionKey: "agent:main:main",
      toolCallId: "tool-list-1",
      toolName: "browser",
      normalizedArgsHash: "c".repeat(64),
      interrupt: { type: "approval", text: "Need approval" },
      timeoutMs: 60_000,
    });

    const pending = await manager.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      approvalRequestId: "approval-list-1",
      toolCallId: "tool-list-1",
      toolName: "browser",
      normalizedArgsHash: "c".repeat(64),
      resumeToken: emitted.requested.resumeToken,
    });

    manager.stop();
    const reloaded = new ToolInterruptManager({ filePath });
    await reloaded.load();
    const pendingAfterReload = await reloaded.listPending();
    expect(pendingAfterReload).toHaveLength(1);
    expect(pendingAfterReload[0]?.resumeToken).not.toBe(emitted.requested.resumeToken);

    const resumed = await reloaded.resume({
      approvalRequestId: "approval-list-1",
      runId: "run-list-1",
      sessionKey: "agent:main:main",
      toolCallId: "tool-list-1",
      toolName: "browser",
      normalizedArgsHash: "c".repeat(64),
      resumeToken: pendingAfterReload[0].resumeToken,
      result: { ok: true },
    });
    expect(resumed).toMatchObject({ ok: true, alreadyResolved: false });
    const persisted = JSON.parse(await fs.readFile(filePath, "utf-8")) as {
      interrupts?: Record<string, { resumeToken?: string }>;
    };
    expect(persisted.interrupts?.["approval-list-1"]?.resumeToken).toBeUndefined();
    reloaded.stop();
  });

  it("enforces expiry and survives restart with persisted records", async () => {
    const filePath = await createTempInterruptPath();
    let now = 1_000_000;
    const nowMs = () => now;
    const manager = new ToolInterruptManager({ filePath, nowMs });
    await manager.load();

    const emitted = await manager.emit({
      approvalRequestId: "approval-3",
      runId: "run-3",
      sessionKey: "agent:main:main",
      toolCallId: "tool-3",
      interrupt: { type: "approval" },
      timeoutMs: 2_000,
    });
    now += 3_000;

    const expired = await manager.resume({
      approvalRequestId: "approval-3",
      runId: "run-3",
      sessionKey: "agent:main:main",
      toolCallId: "tool-3",
      resumeToken: emitted.requested.resumeToken,
      result: { ok: true },
    });
    expect(expired).toMatchObject({
      ok: false,
      code: "expired",
    });
    await expect(emitted.wait).resolves.toMatchObject({
      status: "expired",
      approvalRequestId: "approval-3",
    });

    manager.stop();
    const reloaded = new ToolInterruptManager({ filePath, nowMs });
    await reloaded.load();
    const snapshot = reloaded.getSnapshot("approval-3");
    expect(snapshot?.expiredAtMs).toBeDefined();
    reloaded.stop();
  });

  it("settles pending waits when capacity pruning drops an interrupt", async () => {
    const filePath = await createTempInterruptPath();
    const manager = new ToolInterruptManager({ filePath });
    await manager.load();

    const internal = manager as unknown as {
      records: Map<string, object>;
      pending: Map<string, { promise: Promise<unknown> }>;
      createPendingEntry: (record: object) => { promise: Promise<unknown> };
      pruneRecordsLocked: (now: number) => void;
    };
    const firstRecord = {
      approvalRequestId: "approval-prune-0",
      runId: "run-prune-0",
      sessionKey: "agent:main:main",
      toolCallId: "tool-prune-0",
      interrupt: { type: "approval" },
      createdAtMs: 0,
      expiresAtMs: 60_000,
      resumeTokenHash: "0".repeat(64),
    };
    internal.records.set("approval-prune-0", firstRecord);
    const firstPending = internal.createPendingEntry(firstRecord);
    internal.pending.set("approval-prune-0", firstPending);

    for (let i = 1; i <= 2_000; i += 1) {
      internal.records.set(`approval-prune-${i}`, {
        approvalRequestId: `approval-prune-${i}`,
        runId: `run-prune-${i}`,
        sessionKey: "agent:main:main",
        toolCallId: `tool-prune-${i}`,
        interrupt: { type: "approval" },
        createdAtMs: i,
        expiresAtMs: 60_000 + i,
        resumeTokenHash: `${i}`.padStart(64, "0"),
      });
    }

    internal.pruneRecordsLocked(5_000);

    await expect(firstPending.promise).resolves.toMatchObject({
      status: "expired",
      approvalRequestId: "approval-prune-0",
      runId: "run-prune-0",
      sessionKey: "agent:main:main",
      toolCallId: "tool-prune-0",
      expiresAtMs: 60_000,
    });
    manager.stop();
  });
});
