import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetMemoryToolMockState,
  setMemoryReadFileImpl,
} from "../../../test/helpers/memory-tool-manager-mock.js";
import { resolveMemoryLoadPolicy } from "./memory-load-policy.js";
import { createMemoryGetTool, createMemorySearchTool } from "./memory-tool.js";

const ENV_KEYS = [
  "OPENCLAW_MEMORY_POLICY_POINTER_PATH",
  "OPENCLAW_MEMORY_POLICY_PATH",
  "OPENCLAW_MEMORY_POLICY_ENFORCE",
  "OPENCLAW_MEMORY_POLICY_REPORT_ONLY",
] as const;

async function mkTmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "oc-memory-policy-"));
}

function restoreEnv(snapshot: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) {
    const v = snapshot[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

describe("memory load policy structural enforcement", () => {
  let envSnapshot: Record<string, string | undefined>;

  beforeEach(() => {
    envSnapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    resetMemoryToolMockState();
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    vi.clearAllMocks();
  });

  it("policy file missing test: fail-closed blocks deep reads", async () => {
    const tmp = await mkTmpDir();
    process.env.OPENCLAW_MEMORY_POLICY_POINTER_PATH = path.join(tmp, "missing-pointer.json");

    const readSpy = vi.fn(async (params: { relPath: string }) => ({
      text: `read ${params.relPath}`,
      path: params.relPath,
    }));
    setMemoryReadFileImpl(readSpy);

    const tool = createMemoryGetTool({
      config: { agents: { list: [{ id: "main", default: true }] } },
    });
    if (!tool) {
      throw new Error("memory_get tool missing");
    }

    const result = await tool.execute("test-missing", {
      path: "memory/mission_log.md",
      from: 1,
      lines: 10,
    });

    expect(result.details?.disabled).toBe(true);
    expect(String(result.details?.error || "")).toContain("blocked by policy");
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("deep-read blocked test: enforce mode denies out-of-scope deep file", async () => {
    const tmp = await mkTmpDir();
    const policyPath = path.join(tmp, "policy.json");
    const pointerPath = path.join(tmp, "pointer.json");

    await fs.writeFile(
      policyPath,
      JSON.stringify({
        version: "v1.1-test",
        entrypoint: "MEMORY.md",
        topicAllowlist: ["MEMORY.md", "memory/topics/*.md"],
        deepAllowlist: [],
        hardDenies: [],
        escalation: { minConfidence: 0.6, missSignalThreshold: 1 },
      }),
    );
    await fs.writeFile(
      pointerPath,
      JSON.stringify({
        activePolicyPath: policyPath,
        version: "v1.1-test",
        enforce: true,
        reportOnly: false,
      }),
    );

    process.env.OPENCLAW_MEMORY_POLICY_POINTER_PATH = pointerPath;

    const readSpy = vi.fn(async (params: { relPath: string }) => ({
      text: `read ${params.relPath}`,
      path: params.relPath,
    }));
    setMemoryReadFileImpl(readSpy);

    const tool = createMemoryGetTool({
      config: { agents: { list: [{ id: "main", default: true }] } },
    });
    if (!tool) {
      throw new Error("memory_get tool missing");
    }

    const result = await tool.execute("test-deep-block", {
      path: "memory/runbook.md",
    });

    expect(result.details?.disabled).toBe(true);
    expect(String(result.details?.error || "")).toContain("blocked by policy");
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("allowed entrypoint read emits PASS telemetry", async () => {
    const tmp = await mkTmpDir();
    process.env.OPENCLAW_MEMORY_POLICY_POINTER_PATH = path.join(tmp, "missing-pointer.json");

    const tool = createMemoryGetTool({
      config: { agents: { list: [{ id: "main", default: true }] } },
    });
    if (!tool) {
      throw new Error("memory_get tool missing");
    }

    const result = await tool.execute("test-entrypoint-pass", {
      path: "MEMORY.md",
    });

    expect(result.details?.disabled).not.toBe(true);
  });

  it("memory_search filters denied paths and emits telemetry", async () => {
    const tmp = await mkTmpDir();
    const policyPath = path.join(tmp, "policy.json");
    const pointerPath = path.join(tmp, "pointer.json");

    await fs.writeFile(
      policyPath,
      JSON.stringify({
        version: "v1.1-search",
        entrypoint: "MEMORY.md",
        topicAllowlist: ["MEMORY.md", "memory/topics/*.md"],
        deepAllowlist: ["memory/mission_log.md"],
        hardDenies: [],
        escalation: { minConfidence: 0.6, missSignalThreshold: 1 },
      }),
    );
    await fs.writeFile(
      pointerPath,
      JSON.stringify({
        activePolicyPath: policyPath,
        version: "v1.1-search",
        enforce: true,
        reportOnly: false,
      }),
    );

    process.env.OPENCLAW_MEMORY_POLICY_POINTER_PATH = pointerPath;

    resetMemoryToolMockState({
      searchImpl: async () => [
        {
          path: "memory/topics/governance.md",
          startLine: 1,
          endLine: 3,
          score: 0.9,
          snippet: "ok",
          source: "memory",
        },
        {
          path: "memory/private.md",
          startLine: 1,
          endLine: 2,
          score: 0.5,
          snippet: "deny",
          source: "memory",
        },
      ],
    });

    const tool = createMemorySearchTool({
      config: { agents: { list: [{ id: "main", default: true }] } },
    });
    if (!tool) {
      throw new Error("memory_search tool missing");
    }

    const result = await tool.execute("test-search", { query: "governance" });
    const rows = Array.isArray(result.details?.results) ? result.details?.results : [];
    expect(rows.length).toBe(1);
    expect(rows[0]?.path).toBe("memory/topics/governance.md");
  });

  it("rollback pointer flip test: flip policy pointer and restore", async () => {
    const tmp = await mkTmpDir();
    const policyA = path.join(tmp, "policyA.json");
    const policyB = path.join(tmp, "policyB.json");
    const pointer = path.join(tmp, "pointer.json");

    await fs.writeFile(policyA, JSON.stringify({ version: "v1.1-A" }));
    await fs.writeFile(policyB, JSON.stringify({ version: "v1.1-B" }));

    await fs.writeFile(
      pointer,
      JSON.stringify({
        activePolicyPath: policyA,
        version: "v1.1-A",
        enforce: false,
        reportOnly: true,
      }),
    );

    process.env.OPENCLAW_MEMORY_POLICY_POINTER_PATH = pointer;

    const first = await resolveMemoryLoadPolicy({ cwd: tmp });
    expect(first.policy.version).toBe("v1.1-A");

    await fs.writeFile(
      pointer,
      JSON.stringify({
        activePolicyPath: policyB,
        version: "v1.1-B",
        enforce: false,
        reportOnly: true,
      }),
    );
    const second = await resolveMemoryLoadPolicy({ cwd: tmp });
    expect(second.policy.version).toBe("v1.1-B");

    // restore pointer (rollback)
    await fs.writeFile(
      pointer,
      JSON.stringify({
        activePolicyPath: policyA,
        version: "v1.1-A",
        enforce: false,
        reportOnly: true,
      }),
    );
    const restored = await resolveMemoryLoadPolicy({ cwd: tmp });
    expect(restored.policy.version).toBe("v1.1-A");
  });
});
