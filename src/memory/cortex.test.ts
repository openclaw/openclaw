import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runExec } = vi.hoisted(() => ({
  runExec: vi.fn(),
}));

vi.mock("../process/exec.js", () => ({
  runExec,
}));

import {
  getCortexStatus,
  ingestCortexMemoryFromText,
  listCortexMemoryConflicts,
  previewCortexContext,
  resolveCortexGraphPath,
  resolveCortexMemoryConflict,
  syncCortexCodingContext,
} from "./cortex.js";

afterEach(() => {
  vi.restoreAllMocks();
  runExec.mockReset();
});

describe("cortex bridge", () => {
  it("resolves the default graph path inside the workspace", () => {
    expect(resolveCortexGraphPath("/tmp/workspace")).toBe(
      path.normalize(path.join("/tmp/workspace", ".cortex", "context.json")),
    );
  });

  it("resolves relative graph overrides against the workspace", () => {
    expect(resolveCortexGraphPath("/tmp/workspace", "graphs/main.json")).toBe(
      path.normalize(path.resolve("/tmp/workspace", "graphs/main.json")),
    );
  });

  it("reports availability and graph presence", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cortex-status-"));
    const graphPath = path.join(tmpDir, ".cortex", "context.json");
    await fs.mkdir(path.dirname(graphPath), { recursive: true });
    await fs.writeFile(graphPath, "{}", "utf8");
    runExec.mockResolvedValueOnce({ stdout: "", stderr: "" });

    const status = await getCortexStatus({ workspaceDir: tmpDir });

    expect(status.available).toBe(true);
    expect(status.graphExists).toBe(true);
    expect(status.graphPath).toBe(graphPath);
  });

  it("surfaces Cortex CLI errors in status", async () => {
    runExec.mockRejectedValueOnce(new Error("spawn cortex ENOENT"));

    const status = await getCortexStatus({ workspaceDir: "/tmp/workspace" });

    expect(status.available).toBe(false);
    expect(status.error).toContain("spawn cortex ENOENT");
  });

  it("exports preview context", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cortex-preview-"));
    const graphPath = path.join(tmpDir, ".cortex", "context.json");
    await fs.mkdir(path.dirname(graphPath), { recursive: true });
    await fs.writeFile(graphPath, "{}", "utf8");
    runExec
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "## Cortex Context\n- Python\n", stderr: "" });

    const preview = await previewCortexContext({
      workspaceDir: tmpDir,
      policy: "technical",
      maxChars: 500,
    });

    expect(preview.graphPath).toBe(graphPath);
    expect(preview.policy).toBe("technical");
    expect(preview.maxChars).toBe(500);
    expect(preview.context).toBe("## Cortex Context\n- Python");
  });

  it("reuses a pre-resolved Cortex status for preview without re-probing", async () => {
    const status = {
      available: true,
      workspaceDir: "/tmp/workspace",
      graphPath: "/tmp/workspace/.cortex/context.json",
      graphExists: true,
    } as const;
    runExec.mockResolvedValueOnce({ stdout: "## Cortex Context\n- Python\n", stderr: "" });

    const preview = await previewCortexContext({
      workspaceDir: status.workspaceDir,
      status,
    });

    expect(preview.context).toBe("## Cortex Context\n- Python");
    expect(runExec).toHaveBeenCalledTimes(1);
  });

  it("fails preview when graph is missing", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cortex-preview-missing-"));
    runExec.mockResolvedValueOnce({ stdout: "", stderr: "" });

    await expect(previewCortexContext({ workspaceDir: tmpDir })).rejects.toThrow(
      "Cortex graph not found",
    );
  });

  it("lists memory conflicts from Cortex JSON output", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cortex-conflicts-"));
    const graphPath = path.join(tmpDir, ".cortex", "context.json");
    await fs.mkdir(path.dirname(graphPath), { recursive: true });
    await fs.writeFile(graphPath, "{}", "utf8");
    runExec.mockResolvedValueOnce({ stdout: "", stderr: "" }).mockResolvedValueOnce({
      stdout: JSON.stringify({
        conflicts: [
          {
            id: "conf_1",
            type: "temporal_flip",
            severity: 0.91,
            summary: "Hiring status changed",
          },
        ],
      }),
      stderr: "",
    });

    const conflicts = await listCortexMemoryConflicts({ workspaceDir: tmpDir });

    expect(conflicts).toEqual([
      {
        id: "conf_1",
        type: "temporal_flip",
        severity: 0.91,
        summary: "Hiring status changed",
        nodeLabel: undefined,
        oldValue: undefined,
        newValue: undefined,
      },
    ]);
  });

  it("resolves memory conflicts from Cortex JSON output", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cortex-resolve-"));
    const graphPath = path.join(tmpDir, ".cortex", "context.json");
    await fs.mkdir(path.dirname(graphPath), { recursive: true });
    await fs.writeFile(graphPath, "{}", "utf8");
    runExec.mockResolvedValueOnce({ stdout: "", stderr: "" }).mockResolvedValueOnce({
      stdout: JSON.stringify({
        status: "ok",
        conflict_id: "conf_1",
        nodes_updated: 1,
        nodes_removed: 1,
        commit_id: "ver_123",
      }),
      stderr: "",
    });

    const result = await resolveCortexMemoryConflict({
      workspaceDir: tmpDir,
      conflictId: "conf_1",
      action: "accept-new",
    });

    expect(result).toEqual({
      status: "ok",
      conflictId: "conf_1",
      action: "accept-new",
      nodesUpdated: 1,
      nodesRemoved: 1,
      commitId: "ver_123",
      message: undefined,
    });
  });

  it("syncs coding context to default coding platforms", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cortex-sync-"));
    const graphPath = path.join(tmpDir, ".cortex", "context.json");
    await fs.mkdir(path.dirname(graphPath), { recursive: true });
    await fs.writeFile(graphPath, "{}", "utf8");
    runExec
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const result = await syncCortexCodingContext({
      workspaceDir: tmpDir,
      policy: "technical",
    });

    expect(result.policy).toBe("technical");
    expect(result.platforms).toEqual(["claude-code", "cursor", "copilot"]);
    expect(runExec).toHaveBeenLastCalledWith(
      "cortex",
      [
        "context-write",
        graphPath,
        "--platforms",
        "claude-code",
        "cursor",
        "copilot",
        "--policy",
        "technical",
      ],
      expect.any(Object),
    );
  });

  it("ingests high-signal text into the Cortex graph with merge", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cortex-ingest-"));
    const graphPath = path.join(tmpDir, ".cortex", "context.json");
    await fs.mkdir(path.dirname(graphPath), { recursive: true });
    await fs.writeFile(graphPath, "{}", "utf8");
    runExec
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const result = await ingestCortexMemoryFromText({
      workspaceDir: tmpDir,
      event: {
        actor: "user",
        text: "I prefer concise answers and I am focused on fundraising this quarter.",
        sessionId: "session-1",
        channelId: "channel-1",
        agentId: "main",
      },
    });

    expect(result).toEqual({
      workspaceDir: tmpDir,
      graphPath,
      stored: true,
    });
    expect(runExec).toHaveBeenLastCalledWith(
      "cortex",
      expect.arrayContaining(["extract", "-o", graphPath, "--merge", graphPath]),
      expect.any(Object),
    );
  });

  it("initializes the Cortex graph on first ingest when it is missing", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cortex-first-ingest-"));
    const graphPath = path.join(tmpDir, ".cortex", "context.json");
    runExec
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const result = await ingestCortexMemoryFromText({
      workspaceDir: tmpDir,
      event: {
        actor: "user",
        text: "I prefer concise answers.",
      },
    });

    await expect(fs.readFile(graphPath, "utf8")).resolves.toContain('"nodes"');
    expect(result).toEqual({
      workspaceDir: tmpDir,
      graphPath,
      stored: true,
    });
    expect(runExec).toHaveBeenLastCalledWith(
      "cortex",
      expect.arrayContaining(["extract", "-o", graphPath, "--merge", graphPath]),
      expect.any(Object),
    );
  });
});
