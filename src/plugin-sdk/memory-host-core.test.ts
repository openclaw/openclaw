/**
 * Tests memory host core public artifact discovery and workspace handling.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
  registerMemoryPromptSection,
} from "../plugins/memory-state.js";
import * as memoryCoreAlias from "./memory-core.js";
import {
  buildActiveMemoryPromptSection,
  listMemoryHostPublicArtifacts,
  listActiveMemoryPublicArtifacts,
} from "./memory-host-core.js";
import { appendMemoryHostEvent, resolveMemoryHostEventLogPath } from "./memory-host-events.js";

describe("memory-host-core helpers", () => {
  afterEach(() => {
    clearMemoryPluginState();
  });

  it("exposes the active memory prompt guidance builder for context engines", () => {
    registerMemoryPromptSection(({ citationsMode }) => [
      "## Memory Recall",
      `citations=${citationsMode ?? "default"}`,
      "",
    ]);

    expect(
      buildActiveMemoryPromptSection({
        availableTools: new Set(["memory_search"]),
        citationsMode: "off",
      }),
    ).toEqual(["## Memory Recall", "citations=off", ""]);
  });

  it("exposes active memory public artifacts for companion plugins", async () => {
    registerMemoryCapability("memory-core", {
      publicArtifacts: {
        async listArtifacts() {
          return [
            {
              kind: "memory-root",
              workspaceDir: "/tmp/workspace",
              relativePath: "MEMORY.md",
              absolutePath: "/tmp/workspace/MEMORY.md",
              agentIds: ["main"],
              contentType: "markdown" as const,
            },
          ];
        },
      },
    });

    await expect(listActiveMemoryPublicArtifacts({ cfg: {} as never })).resolves.toEqual([
      {
        kind: "memory-root",
        workspaceDir: "/tmp/workspace",
        relativePath: "MEMORY.md",
        absolutePath: "/tmp/workspace/MEMORY.md",
        agentIds: ["main"],
        contentType: "markdown",
      },
    ]);
  });

  it("lists shared public artifacts from memory workspaces", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-public-artifacts-"));
    try {
      const workspaceDir = path.join(fixtureRoot, "workspace");
      const canonicalWorkspaceDir = await fs
        .realpath(fixtureRoot)
        .then((root) => path.join(root, "workspace"));
      await fs.mkdir(path.join(workspaceDir, "memory", "dreaming"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Durable Memory\n", "utf8");
      await fs.writeFile(
        path.join(workspaceDir, "memory", "2026-05-18.md"),
        "# Daily Note\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(workspaceDir, "memory", "dreaming", "2026-05-18.md"),
        "# Dream Report\n",
        "utf8",
      );
      await appendMemoryHostEvent(workspaceDir, {
        type: "memory.recall.recorded",
        timestamp: "2026-05-18T12:00:00.000Z",
        query: "bridge",
        resultCount: 0,
        results: [],
      });

      await expect(
        listMemoryHostPublicArtifacts({
          cfg: {
            agents: {
              list: [
                {
                  id: "main",
                  default: true,
                  workspace: workspaceDir,
                  memory: {
                    extensions: {
                      "memory-core": {
                        dreaming: { enabled: false },
                      },
                    },
                  },
                },
              ],
            },
          },
        }),
      ).resolves.toEqual([
        {
          kind: "memory-root",
          workspaceDir: canonicalWorkspaceDir,
          relativePath: "MEMORY.md",
          absolutePath: path.join(canonicalWorkspaceDir, "MEMORY.md"),
          agentIds: ["main"],
          contentType: "markdown",
        },
        {
          kind: "daily-note",
          workspaceDir: canonicalWorkspaceDir,
          relativePath: "memory/2026-05-18.md",
          absolutePath: path.join(canonicalWorkspaceDir, "memory", "2026-05-18.md"),
          agentIds: ["main"],
          contentType: "markdown",
        },
        {
          kind: "dream-report",
          workspaceDir: canonicalWorkspaceDir,
          relativePath: "memory/dreaming/2026-05-18.md",
          absolutePath: path.join(canonicalWorkspaceDir, "memory", "dreaming", "2026-05-18.md"),
          agentIds: ["main"],
          contentType: "markdown",
        },
        {
          kind: "event-log",
          workspaceDir: canonicalWorkspaceDir,
          relativePath: "memory/.dreams/events.jsonl",
          absolutePath: resolveMemoryHostEventLogPath(canonicalWorkspaceDir),
          agentIds: ["main"],
          contentType: "json",
        },
      ]);
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("lists only the requested agent's workspace artifacts", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-agent-artifacts-"));
    try {
      const researchWorkspace = path.join(fixtureRoot, "research");
      const writerWorkspace = path.join(fixtureRoot, "writer");
      const canonicalResearchWorkspace = await fs
        .realpath(fixtureRoot)
        .then((root) => path.join(root, "research"));
      await fs.mkdir(researchWorkspace, { recursive: true });
      await fs.mkdir(writerWorkspace, { recursive: true });
      await fs.writeFile(path.join(researchWorkspace, "MEMORY.md"), "# Research\n", "utf8");
      await fs.writeFile(path.join(writerWorkspace, "MEMORY.md"), "# Writer\n", "utf8");

      const artifacts = await listMemoryHostPublicArtifacts({
        cfg: {
          agents: {
            list: [
              { id: "research", workspace: researchWorkspace },
              { id: "writer", workspace: writerWorkspace },
            ],
          },
        },
        agentId: "research",
      });

      expect(artifacts).toEqual([
        {
          kind: "memory-root",
          workspaceDir: canonicalResearchWorkspace,
          relativePath: "MEMORY.md",
          absolutePath: path.join(canonicalResearchWorkspace, "MEMORY.md"),
          agentIds: ["research"],
          contentType: "markdown",
        },
      ]);
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("keeps agent-scoped dream artifacts private in shared workspaces", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-agent-dreams-"));
    try {
      const workspaceDir = path.join(fixtureRoot, "workspace");
      await fs.mkdir(path.join(workspaceDir, "memory", ".dreams", "agents", "research"), {
        recursive: true,
      });
      await fs.mkdir(path.join(workspaceDir, "memory", ".dreams", "agents", "writer"), {
        recursive: true,
      });
      await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Shared\n", "utf8");
      await fs.writeFile(path.join(workspaceDir, "memory", "2026-05-18.md"), "# Daily\n", "utf8");
      await fs.writeFile(
        path.join(workspaceDir, "memory", ".dreams", "agents", "research", "DREAMS.md"),
        "# Research Dream Diary\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(workspaceDir, "memory", ".dreams", "agents", "writer", "DREAMS.md"),
        "# Writer Dream Diary\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(workspaceDir, "memory", ".dreams", "legacy-unscoped.md"),
        "# Legacy Dream Artifact\n",
        "utf8",
      );
      await fs.mkdir(path.join(workspaceDir, "memory", "dreaming"), { recursive: true });
      await fs.writeFile(
        path.join(workspaceDir, "memory", "dreaming", "legacy-report.md"),
        "# Legacy Dream Report\n",
        "utf8",
      );
      await appendMemoryHostEvent(
        workspaceDir,
        {
          type: "memory.recall.recorded",
          timestamp: "2026-05-18T12:00:00.000Z",
          query: "research-only",
          resultCount: 0,
          results: [],
        },
        "research",
      );
      await appendMemoryHostEvent(
        workspaceDir,
        {
          type: "memory.recall.recorded",
          timestamp: "2026-05-18T12:01:00.000Z",
          query: "writer-only",
          resultCount: 0,
          results: [],
        },
        "writer",
      );
      await appendMemoryHostEvent(workspaceDir, {
        type: "memory.recall.recorded",
        timestamp: "2026-05-18T12:02:00.000Z",
        query: "legacy-shared",
        resultCount: 0,
        results: [],
      });

      const cfg = {
        agents: {
          list: [
            { id: "research", default: true, workspace: workspaceDir },
            { id: "writer", workspace: workspaceDir },
          ],
        },
      };
      const researchArtifacts = await listMemoryHostPublicArtifacts({
        cfg,
        agentId: "Research",
      });
      expect(researchArtifacts.map((artifact) => artifact.relativePath)).toEqual([
        "MEMORY.md",
        "memory/.dreams/agents/research/DREAMS.md",
        "memory/2026-05-18.md",
        "memory/.dreams/agents/research/events.jsonl",
      ]);
      expect(
        researchArtifacts.find((artifact) => artifact.kind === "dream-report")?.agentIds,
      ).toEqual(["research"]);

      const allArtifacts = await listMemoryHostPublicArtifacts({ cfg });
      expect(
        allArtifacts.find((artifact) => artifact.relativePath.includes("/research/"))?.agentIds,
      ).toEqual(["research"]);
      expect(
        allArtifacts.find((artifact) => artifact.relativePath.includes("/writer/"))?.agentIds,
      ).toEqual(["writer"]);
      expect(
        allArtifacts.some((artifact) => artifact.relativePath === "memory/.dreams/events.jsonl"),
      ).toBe(false);
      expect(
        allArtifacts.some(
          (artifact) => artifact.relativePath === "memory/.dreams/legacy-unscoped.md",
        ),
      ).toBe(false);
      expect(
        allArtifacts.some(
          (artifact) => artifact.relativePath === "memory/dreaming/legacy-report.md",
        ),
      ).toBe(false);
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("treats symlinked workspace aliases as one shared workspace", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-workspace-alias-"));
    try {
      const workspaceDir = path.join(fixtureRoot, "workspace");
      const workspaceAliasDir = path.join(fixtureRoot, "workspace-alias");
      await fs.mkdir(path.join(workspaceDir, "memory", "dreaming"), { recursive: true });
      await fs.symlink(workspaceDir, workspaceAliasDir);
      await fs.writeFile(
        path.join(workspaceDir, "memory", "dreaming", "legacy-report.md"),
        "# Legacy Dream Report\n",
        "utf8",
      );
      await appendMemoryHostEvent(workspaceDir, {
        type: "memory.recall.recorded",
        timestamp: "2026-05-18T12:00:00.000Z",
        query: "legacy-shared",
        resultCount: 0,
        results: [],
      });

      const artifacts = await listMemoryHostPublicArtifacts({
        cfg: {
          agents: {
            list: [
              { id: "research", default: true, workspace: workspaceDir },
              { id: "writer", workspace: workspaceAliasDir },
            ],
          },
        },
      });

      expect(
        artifacts.some((artifact) => artifact.relativePath === "memory/dreaming/legacy-report.md"),
      ).toBe(false);
      expect(
        artifacts.some((artifact) => artifact.relativePath === "memory/.dreams/events.jsonl"),
      ).toBe(false);
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("publishes canonical artifact paths for symlinked workspace aliases", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-workspace-path-"));
    try {
      const workspaceDir = path.join(fixtureRoot, "workspace");
      const workspaceAliasDir = path.join(fixtureRoot, "workspace-alias");
      const outsideDir = path.join(fixtureRoot, "outside");
      await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
      await fs.writeFile(
        path.join(workspaceDir, "memory", "2026-05-18.md"),
        "# Original\n",
        "utf8",
      );
      await fs.symlink(workspaceDir, workspaceAliasDir);
      const canonicalWorkspaceDir = await fs.realpath(workspaceDir);

      const artifacts = await listMemoryHostPublicArtifacts({
        cfg: {
          agents: {
            list: [{ id: "research", workspace: workspaceAliasDir }],
          },
        },
      });
      const artifact = artifacts.find(
        (candidate) => candidate.relativePath === "memory/2026-05-18.md",
      );
      expect(artifact?.workspaceDir).toBe(canonicalWorkspaceDir);
      expect(artifact?.absolutePath).toBe(
        path.join(canonicalWorkspaceDir, "memory", "2026-05-18.md"),
      );

      await fs.unlink(workspaceAliasDir);
      await fs.mkdir(path.join(outsideDir, "memory"), { recursive: true });
      await fs.writeFile(path.join(outsideDir, "memory", "2026-05-18.md"), "# Outside\n", "utf8");
      await fs.symlink(outsideDir, workspaceAliasDir);

      await expect(fs.readFile(artifact?.absolutePath ?? "", "utf8")).resolves.toBe("# Original\n");
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("does not traverse a symlinked memory directory", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-memory-link-"));
    try {
      const workspaceDir = path.join(fixtureRoot, "workspace");
      const linkedMemoryDir = path.join(workspaceDir, "notes");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(linkedMemoryDir, { recursive: true });
      await fs.writeFile(path.join(linkedMemoryDir, "private.md"), "# Private\n", "utf8");
      await fs.symlink(linkedMemoryDir, path.join(workspaceDir, "memory"));

      const artifacts = await listMemoryHostPublicArtifacts({
        cfg: {
          agents: {
            list: [{ id: "research", workspace: workspaceDir }],
          },
        },
      });

      expect(artifacts).toEqual([]);
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("ignores event journals below symlinked parent directories", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-event-parent-link-"));
    try {
      const workspaceDir = path.join(fixtureRoot, "workspace");
      const outsideDreamsDir = path.join(fixtureRoot, "outside-dreams");
      const eventLogPath = path.join(outsideDreamsDir, "agents", "research", "events.jsonl");
      await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
      await fs.mkdir(path.dirname(eventLogPath), { recursive: true });
      await fs.writeFile(eventLogPath, '{"type":"memory.recall.recorded"}\n', "utf8");
      await fs.symlink(outsideDreamsDir, path.join(workspaceDir, "memory", ".dreams"));

      const artifacts = await listMemoryHostPublicArtifacts({
        cfg: {
          agents: {
            list: [{ id: "research", workspace: workspaceDir }],
          },
        },
      });

      expect(artifacts.some((artifact) => artifact.kind === "event-log")).toBe(false);
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("ignores symlinked agent event journals", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-event-link-"));
    try {
      const workspaceDir = path.join(fixtureRoot, "workspace");
      const eventLogPath = resolveMemoryHostEventLogPath(workspaceDir, "research");
      const outsidePath = path.join(fixtureRoot, "outside-events.jsonl");
      await fs.mkdir(path.dirname(eventLogPath), { recursive: true });
      await fs.writeFile(outsidePath, '{"type":"memory.recall.recorded"}\n', "utf8");
      await fs.symlink(outsidePath, eventLogPath);

      const artifacts = await listMemoryHostPublicArtifacts({
        cfg: {
          agents: {
            list: [{ id: "research", workspace: workspaceDir }],
          },
        },
      });

      expect(artifacts.some((artifact) => artifact.kind === "event-log")).toBe(false);
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("keeps the deprecated memory-core alias wired to memory-host-core", () => {
    expect(memoryCoreAlias.buildActiveMemoryPromptSection).toBe(buildActiveMemoryPromptSection);
    expect(memoryCoreAlias.listActiveMemoryPublicArtifacts).toBe(listActiveMemoryPublicArtifacts);
  });
});
