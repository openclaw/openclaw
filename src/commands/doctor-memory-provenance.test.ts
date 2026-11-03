import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  renderStructuredHealthFindings,
  showDoctorHealthSummary,
} from "../flows/doctor-health-contribution.js";
import {
  readMemoryArtifactProvenance,
  recordMemoryArtifactWriteProvenance,
} from "../memory/memory-artifact-provenance.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  collectMemoryProvenanceExclusionFindings,
  MEMORY_PROVENANCE_CHECK_ID,
} from "./doctor-memory-provenance.js";
import { createCapturingTestRuntime } from "./test-runtime-config-helpers.js";

const memoryRuntime = vi.hoisted(() => ({ available: true }));

vi.mock("../plugins/memory-runtime.js", async (importActual) => ({
  ...(await importActual<typeof import("../plugins/memory-runtime.js")>()),
  // Stand in for the host classifier: stored provenance, absent records stay eligible.
  classifyActiveMemoryWorkspacePaths: async (params: {
    workspaceDir: string;
    relativePaths: string[];
  }) =>
    memoryRuntime.available
      ? {
          status: "classified",
          classifications: await Promise.all(
            params.relativePaths.map(async (relativePath) => ({
              relativePath,
              originClass:
                (
                  await readMemoryArtifactProvenance({
                    workspaceDir: params.workspaceDir,
                    relativePath,
                  })
                )?.originClass ?? "agent",
            })),
          ),
        }
      : { status: "unavailable" },
}));

beforeEach(() => {
  memoryRuntime.available = true;
});

afterEach(() => {
  resetPluginStateStoreForTests();
});

async function writeTracked(params: {
  workspaceDir: string;
  relativePath: string;
  content: string;
  originClass: "agent" | "untrusted";
  observedAt: number;
  sessionKey: string;
}) {
  const filePath = path.join(params.workspaceDir, params.relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const before = await fs.readFile(filePath, "utf8").catch(() => "");
  await fs.writeFile(filePath, params.content);
  await recordMemoryArtifactWriteProvenance({
    workspaceDir: params.workspaceDir,
    relativePath: params.relativePath,
    contentBefore: before,
    contentAfter: params.content,
    originClass: params.originClass,
    observedAt: params.observedAt,
    sessionKey: params.sessionKey,
  });
}

function withWorkspace(run: (workspaceDir: string, cfg: OpenClawConfig) => Promise<void>) {
  return withStateDirEnv("doctor-memory-provenance-", async ({ tempRoot }) => {
    const workspaceDir = path.join(tempRoot, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await run(workspaceDir, { agents: { entries: { main: { workspace: workspaceDir } } } });
  });
}

it("reports untrusted root memory files with the last recorded write", async () => {
  await withWorkspace(async (workspaceDir, cfg) => {
    const latestAt = Date.parse("2026-10-31T14:19:33.782Z");
    await writeTracked({
      workspaceDir,
      relativePath: "MEMORY.md",
      content: "first",
      originClass: "untrusted",
      observedAt: Date.parse("2026-10-25T17:00:00.000Z"),
      sessionKey: "agent:main:quarantining",
    });
    // An owner write keeps the ratchet at untrusted and replaces time and session.
    await writeTracked({
      workspaceDir,
      relativePath: "MEMORY.md",
      content: "second",
      originClass: "agent",
      observedAt: latestAt,
      sessionKey: "agent:main:latest",
    });
    await writeTracked({
      workspaceDir,
      relativePath: "USER.md",
      content: "user",
      originClass: "agent",
      observedAt: latestAt,
      sessionKey: "agent:main:latest",
    });

    const findings = await collectMemoryProvenanceExclusionFindings(cfg);
    const message =
      "MEMORY.md is excluded from automatic context: its memory provenance is untrusted. Last recorded tracked write: 2026-10-31T14:19:33.782Z, session agent:main:latest. The record names only the latest tracked write, not necessarily the write that quarantined the file.";

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: MEMORY_PROVENANCE_CHECK_ID,
        severity: "warning",
        path: path.join(workspaceDir, "MEMORY.md"),
        message,
      }),
    ]);
    // The Gateway warning points operators at plain `openclaw doctor`, so the summary must show it.
    const { runtime, logs } = createCapturingTestRuntime();
    const ctx = { runtime, healthFindings: [] };
    renderStructuredHealthFindings(ctx, findings);
    showDoctorHealthSummary(ctx);
    expect(logs).toEqual(
      expect.arrayContaining([
        "Fix now:",
        `- ${message}`,
        `  Location: ${path.join(workspaceDir, "MEMORY.md")}`,
      ]),
    );
  });
});

it("reports quarantined personal USER.md files", async () => {
  await withWorkspace(async (workspaceDir, cfg) => {
    await writeTracked({
      workspaceDir,
      relativePath: "users/profile-a/USER.md",
      content: "personal",
      originClass: "untrusted",
      observedAt: Date.parse("2026-10-25T17:00:00.000Z"),
      sessionKey: "agent:main:quarantining",
    });

    const findings = await collectMemoryProvenanceExclusionFindings(cfg);

    expect(findings.map((entry) => entry.path)).toEqual([
      path.join(workspaceDir, "users/profile-a/USER.md"),
    ]);
  });
});

it("does not report files that bootstrap keeps", async () => {
  await withWorkspace(async (workspaceDir, cfg) => {
    await writeTracked({
      workspaceDir,
      relativePath: "USER.md",
      content: "user",
      originClass: "untrusted",
      observedAt: Date.parse("2026-10-25T17:00:00.000Z"),
      sessionKey: "agent:main:quarantining",
    });
    await writeTracked({
      workspaceDir,
      relativePath: "MEMORY.md",
      content: "memory",
      originClass: "untrusted",
      observedAt: Date.parse("2026-10-25T17:00:00.000Z"),
      sessionKey: "agent:main:quarantining",
    });
    await fs.rm(path.join(workspaceDir, "USER.md"));
    // Without a memory runtime the bootstrap gate injects files regardless of stored provenance.
    memoryRuntime.available = false;

    await expect(collectMemoryProvenanceExclusionFindings(cfg)).resolves.toEqual([]);
    memoryRuntime.available = true;
    expect(
      (await collectMemoryProvenanceExclusionFindings(cfg)).map((entry) => entry.path),
    ).toEqual([path.join(workspaceDir, "MEMORY.md")]);
  });
});
