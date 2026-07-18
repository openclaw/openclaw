import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { clearMemoryPluginState } from "../plugins/memory-state.test-fixtures.js";
import { listMemoryHostPublicArtifacts } from "./memory-host-core.js";
import { appendMemoryHostEvent } from "./memory-host-events.js";

describe("memory host event export recovery", () => {
  afterEach(() => {
    clearMemoryPluginState();
    resetPluginStateStoreForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("finishes an inode-owned empty event export after interruption", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-inode-owner-"));
    const stateDir = path.join(fixtureRoot, "state");
    const workspaceDir = path.join(fixtureRoot, "workspace");
    const event = {
      type: "memory.recall.recorded" as const,
      timestamp: "2026-05-18T12:00:00.000Z",
      query: "recover inode-owned export",
      resultCount: 0,
      results: [],
    };
    try {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      await fs.mkdir(workspaceDir);
      await appendMemoryHostEvent(workspaceDir, event);
      const stateHash = createHash("sha256")
        .update(await fs.realpath(stateDir))
        .digest("hex")
        .slice(0, 32);
      const workspaceHash = createHash("sha256")
        .update(await fs.realpath(workspaceDir))
        .digest("hex")
        .slice(0, 32);
      const exportDir = path.join(workspaceDir, "memory", "events", stateHash);
      const exportPath = path.join(exportDir, "memory-host-events.jsonl");
      const ownerPath = path.join(exportDir, ".openclaw-memory-host-events-owner.json");
      const expectedContent = `${JSON.stringify(event)}\n`;
      await fs.mkdir(exportDir, { recursive: true });
      await fs.writeFile(exportPath, "", { mode: 0o600 });
      const exportStat = await fs.stat(exportPath, { bigint: true });
      await fs.writeFile(
        ownerPath,
        `${JSON.stringify({
          schemaVersion: 3,
          kind: "openclaw-memory-host-events-export",
          stateHash,
          workspaceHash,
          pendingContentSha256: createHash("sha256").update(expectedContent).digest("hex"),
          fileDev: String(exportStat.dev),
          fileIno: String(exportStat.ino),
        })}\n`,
        "utf8",
      );

      const listed = await listMemoryHostPublicArtifacts({
        cfg: { agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] } },
      });

      expect(listed.some((artifact) => artifact.kind === "event-log")).toBe(true);
      await expect(fs.readFile(exportPath, "utf8")).resolves.toBe(expectedContent);
      const owner = JSON.parse(await fs.readFile(ownerPath, "utf8")) as {
        contentSha256?: string;
        fileDev?: string;
        fileIno?: string;
        pendingContentSha256?: string;
      };
      expect(owner).toMatchObject({
        contentSha256: createHash("sha256").update(expectedContent).digest("hex"),
        fileDev: expect.any(String),
        fileIno: expect.any(String),
      });
      expect(owner.pendingContentSha256).toBeUndefined();
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("does not claim an empty export after exclusive-create interruption", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-empty-export-"));
    const stateDir = path.join(fixtureRoot, "state");
    const workspaceDir = path.join(fixtureRoot, "workspace");
    const event = {
      type: "memory.recall.recorded" as const,
      timestamp: "2026-05-18T12:00:00.000Z",
      query: "leave empty export untouched",
      resultCount: 0,
      results: [],
    };
    try {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      await fs.mkdir(workspaceDir);
      await appendMemoryHostEvent(workspaceDir, event);
      const stateHash = createHash("sha256")
        .update(await fs.realpath(stateDir))
        .digest("hex")
        .slice(0, 32);
      const workspaceHash = createHash("sha256")
        .update(await fs.realpath(workspaceDir))
        .digest("hex")
        .slice(0, 32);
      const exportDir = path.join(workspaceDir, "memory", "events", stateHash);
      const exportPath = path.join(exportDir, "memory-host-events.jsonl");
      const ownerPath = path.join(exportDir, ".openclaw-memory-host-events-owner.json");
      const expectedContent = `${JSON.stringify(event)}\n`;
      await fs.mkdir(exportDir, { recursive: true });
      await fs.writeFile(exportPath, "", { mode: 0o600 });
      await fs.writeFile(
        ownerPath,
        `${JSON.stringify({
          schemaVersion: 3,
          kind: "openclaw-memory-host-events-export",
          stateHash,
          workspaceHash,
          pendingContentSha256: createHash("sha256").update(expectedContent).digest("hex"),
        })}\n`,
        "utf8",
      );

      const listed = await listMemoryHostPublicArtifacts({
        cfg: { agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] } },
      });

      expect(listed.some((artifact) => artifact.kind === "event-log")).toBe(false);
      await expect(fs.readFile(exportPath, "utf8")).resolves.toBe("");
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
