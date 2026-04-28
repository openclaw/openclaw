import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("work object store", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  let tempStateDir: string | null = null;

  afterEach(async () => {
    vi.resetModules();
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true });
      tempStateDir = null;
    }
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  async function loadStoreModule() {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-work-objects-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    vi.resetModules();
    return await import("./store.js");
  }

  it("persists durable work objects with evidence", async () => {
    const store = await loadStoreModule();

    const obj = store.createWorkObject({
      kind: "subagent",
      title: "Build proof packets",
      goal: "Add evidence-first completion packets",
      status: "running",
      source: { type: "sessions_spawn", id: "run-1" },
      actor: { runId: "run-1", sessionKey: "agent:main:subagent:1" },
      recovery: { policy: "resume" },
      evidence: [
        {
          kind: "session",
          label: "Worker session",
          value: "agent:main:subagent:1",
        },
      ],
      nowMs: 10,
    });

    expect(obj.id).toMatch(/^wo_/);
    expect(obj.status).toBe("running");

    const raw = JSON.parse(await fs.readFile(store.resolveWorkObjectStorePath(), "utf8")) as {
      objects?: Record<string, { evidence?: unknown[] }>;
    };
    expect(raw.objects?.[obj.id]?.evidence).toHaveLength(1);

    vi.resetModules();
    const restored = await import("./store.js");
    expect(restored.getWorkObject(obj.id)?.goal).toBe("Add evidence-first completion packets");
  });

  it("creates proof packets on completion", async () => {
    const store = await loadStoreModule();
    const obj = store.createWorkObject({
      kind: "subagent",
      title: "Run focused tests",
      goal: "Verify the work object layer",
      source: { type: "sessions_spawn", id: "run-2" },
      recovery: { policy: "resume" },
      nowMs: 100,
    });

    const completed = store.completeWorkObject({
      id: obj.id,
      status: "succeeded",
      summary: "Focused tests passed",
      output: "2 tests passed",
      evidence: [
        {
          kind: "test",
          label: "vitest",
          value: "src/work-objects/store.test.ts passed",
        },
      ],
      metrics: { startedAtMs: 100, endedAtMs: 250, durationMs: 150 },
      nowMs: 250,
    });

    expect(completed?.status).toBe("succeeded");
    expect(completed?.proofPacket?.summary).toBe("Focused tests passed");
    expect(completed?.proofPacket?.evidence.some((item) => item.kind === "test")).toBe(true);
    expect(completed?.endedAtMs).toBe(250);
  });

  it("tracks heterogeneous Codex, Clawd, and Gemini worker policy", async () => {
    const store = await loadStoreModule();
    const { createDefaultCodingWorkerPolicy, evaluateWorkObjectPolicy } =
      await import("./policy.js");
    const obj = store.createWorkObject({
      kind: "subagent",
      title: "Implement guarded orchestration",
      goal: "Use model diversity before final success",
      source: { type: "sessions_spawn", id: "run-codex" },
      recovery: { policy: "resume" },
      workerPolicy: createDefaultCodingWorkerPolicy(),
      workerRuns: [
        {
          id: "codex-run",
          role: "implementer",
          engine: "codex",
          status: "succeeded",
          verdict: { status: "pass", summary: "Implemented" },
        },
        {
          id: "clawd-run",
          role: "reviewer",
          engine: "claude-code",
          model: "opus47-cli",
          modelStrategy: "explicit",
          status: "succeeded",
          verdict: { status: "pass", summary: "Reviewed" },
        },
      ],
      nowMs: 10,
    });

    expect(evaluateWorkObjectPolicy(obj)).toMatchObject({
      satisfied: false,
      missingRoles: ["verifier"],
      failedRoles: [],
    });

    const withGemini = store.addWorkObjectWorkerRun(
      obj.id,
      {
        id: "gemini-run",
        role: "verifier",
        engine: "gemini-cli",
        modelStrategy: "strongest_available",
        status: "succeeded",
        verdict: { status: "pass", summary: "Verified" },
      },
      20,
    );

    expect(withGemini?.workerRuns.map((run) => run.engine)).toEqual([
      "codex",
      "claude-code",
      "gemini-cli",
    ]);
    expect(withGemini ? evaluateWorkObjectPolicy(withGemini).satisfied : false).toBe(true);
  });

  it("marks running work interrupted during restart recovery", async () => {
    const store = await loadStoreModule();
    const running = store.createWorkObject({
      kind: "subagent",
      title: "Long run",
      goal: "Survive restart",
      status: "running",
      source: { type: "sessions_spawn", id: "run-3" },
      recovery: { policy: "resume" },
      nowMs: 1,
    });
    store.createWorkObject({
      kind: "manual",
      title: "Done run",
      goal: "Stay done",
      status: "succeeded",
      source: { type: "manual" },
      nowMs: 1,
    });

    const changed = store.markInterruptedWorkObjects({ reason: "test restart", nowMs: 50 });

    expect(changed.map((item) => item.id)).toEqual([running.id]);
    const after = store.getWorkObject(running.id);
    expect(after?.status).toBe("interrupted");
    expect(after?.recovery.attempts).toBe(1);
    expect(after?.evidence.at(-1)?.label).toBe("Restart recovery");
  });
});
