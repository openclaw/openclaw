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
              list: [{ id: "main", default: true, workspace: workspaceDir }],
            },
          },
        }),
      ).resolves.toEqual([
        {
          kind: "memory-root",
          workspaceDir,
          relativePath: "MEMORY.md",
          absolutePath: path.join(workspaceDir, "MEMORY.md"),
          agentIds: ["main"],
          contentType: "markdown",
        },
        {
          kind: "daily-note",
          workspaceDir,
          relativePath: "memory/2026-05-18.md",
          absolutePath: path.join(workspaceDir, "memory", "2026-05-18.md"),
          agentIds: ["main"],
          contentType: "markdown",
        },
        {
          kind: "dream-report",
          workspaceDir,
          relativePath: "memory/dreaming/2026-05-18.md",
          absolutePath: path.join(workspaceDir, "memory", "dreaming", "2026-05-18.md"),
          agentIds: ["main"],
          contentType: "markdown",
        },
        {
          kind: "event-log",
          workspaceDir,
          relativePath: "memory/.dreams/events.jsonl",
          absolutePath: resolveMemoryHostEventLogPath(workspaceDir),
          agentIds: ["main"],
          contentType: "json",
        },
      ]);
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("skips a memory-wiki vault nested under memory/ to avoid the bridge self-import loop (#95657)", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-wiki-skip-"));
    try {
      const workspaceDir = path.join(fixtureRoot, "workspace");
      const wikiSources = path.join(workspaceDir, "memory", "wiki", "sources");
      const wikiMarker = path.join(workspaceDir, "memory", "wiki", ".openclaw-wiki");
      await fs.mkdir(wikiSources, { recursive: true });
      await fs.mkdir(wikiMarker, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "memory", "real-note.md"), "# Note\n", "utf8");
      // Bridge-generated source pages that must NOT be re-indexed as memory.
      await fs.writeFile(
        path.join(wikiSources, "bridge-workspace-abc-memory-real-note.md"),
        "# Imported\n",
        "utf8",
      );

      const artifacts = await listMemoryHostPublicArtifacts({
        cfg: { agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] } },
      });
      const relativePaths = artifacts.map((artifact) => artifact.relativePath);
      expect(relativePaths).toContain("memory/real-note.md");
      expect(relativePaths.some((relativePath) => relativePath.includes("wiki/sources"))).toBe(
        false,
      );
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("keeps the deprecated memory-core alias wired to memory-host-core", () => {
    expect(memoryCoreAlias.buildActiveMemoryPromptSection).toBe(buildActiveMemoryPromptSection);
    expect(memoryCoreAlias.listActiveMemoryPublicArtifacts).toBe(listActiveMemoryPublicArtifacts);
  });
});
