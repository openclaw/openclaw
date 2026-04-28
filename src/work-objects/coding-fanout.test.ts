import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpawnResult } from "../process/exec.js";

describe("coding fanout", () => {
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

  async function loadModules() {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fanout-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    vi.resetModules();
    const store = await import("./store.js");
    const fanout = await import("./coding-fanout.js");
    return { store, fanout };
  }

  function ok(stdout: string): SpawnResult {
    return { stdout, stderr: "", code: 0, signal: null, killed: false, termination: "exit" };
  }

  it("runs Codex, Clawd, and Gemini and marks the work object succeeded", async () => {
    const { store, fanout } = await loadModules();
    const obj = store.createWorkObject({
      kind: "subagent",
      title: "fanout",
      goal: "run all workers",
      source: { type: "manual" },
      recovery: { policy: "resume" },
    });
    const calls: string[][] = [];
    const runner = vi.fn(async ({ argv }: { argv: string[] }) => {
      calls.push(argv);
      const bin = argv[0];
      if (bin === "codex") {
        return ok("PASS codex implemented; tests passed");
      }
      if (bin === "claude") {
        return ok("PASS clawd reviewed; no blockers");
      }
      if (bin === "gemini") {
        return ok("PASS gemini verified independently");
      }
      throw new Error(`unexpected command ${String(bin)}`);
    });

    const result = await fanout.runCodingFanout({
      workObjectId: obj.id,
      workspaceDir: tempStateDir ?? process.cwd(),
      task: "do the thing",
      runner,
      nowMs: (() => {
        let t = 100;
        return () => (t += 1);
      })(),
    });

    expect(result.status).toBe("succeeded");
    expect(result.policySatisfied).toBe(true);
    expect(calls.map((argv) => argv[0])).toEqual(["codex", "claude", "gemini"]);
    expect(calls[1]).toContain("--model");
    expect(calls[1]).toContain("claude-opus-4-7");
    expect(calls[2]).not.toContain("--model");
    const after = store.getWorkObject(obj.id);
    expect(after?.workerRuns.map((run) => run.engine)).toEqual([
      "codex",
      "claude-code",
      "gemini-cli",
    ]);
    expect(after?.proofPacket?.workerRuns).toHaveLength(3);
  });

  it("blocks Ada medical-device work until a regulatory package is attached", async () => {
    const { store, fanout } = await loadModules();
    const obj = store.createWorkObject({
      kind: "subagent",
      title: "ada fanout",
      goal: "run all workers plus regulatory gate",
      source: { type: "manual" },
      recovery: { policy: "resume" },
    });
    const runner = vi.fn(async () => ok("PASS ok"));

    const result = await fanout.runCodingFanout({
      workObjectId: obj.id,
      workspaceDir: path.join(tempStateDir ?? process.cwd(), "engineering", "medical-engine"),
      task: "touch medical-device code",
      changedFiles: ["engineering/medical-engine/src/foo.ts"],
      runner,
    });

    expect(result.status).toBe("needs_review");
    expect(result.policySatisfied).toBe(false);
    expect(result.failedRoles).toEqual(["judge"]);
    const after = store.getWorkObject(obj.id);
    expect(after?.workerPolicy?.id).toBe("codex-clawd-gemini-ada-regulatory");
    expect(after?.workerRuns.at(-1)?.role).toBe("judge");
    expect(after?.workerRuns.at(-1)?.verdict?.status).toBe("fail");
  });
});
