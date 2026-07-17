/**
 * Tests memory host core public artifact discovery and workspace handling.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
  registerMemoryPromptSection,
} from "../plugins/memory-state.test-fixtures.js";
import * as memoryCoreAlias from "./memory-core.js";
import {
  buildActiveMemoryPromptSection,
  listMemoryHostPublicArtifacts,
  listActiveMemoryPublicArtifacts,
} from "./memory-host-core.js";
import { appendMemoryHostEvent } from "./memory-host-events.js";

describe("memory-host-core helpers", () => {
  afterEach(() => {
    clearMemoryPluginState();
    resetPluginStateStoreForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
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
      vi.stubEnv("OPENCLAW_STATE_DIR", fixtureRoot);
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
      const eventStoredAt = Date.parse("2026-05-19T09:30:00.000Z");
      vi.spyOn(Date, "now").mockReturnValue(eventStoredAt);
      await appendMemoryHostEvent(workspaceDir, {
        type: "memory.recall.recorded",
        timestamp: "2026-05-18T12:00:00.000Z",
        query: "bridge",
        resultCount: 0,
        results: [],
      });

      const artifacts = await listMemoryHostPublicArtifacts({
        cfg: {
          agents: {
            list: [{ id: "main", default: true, workspace: workspaceDir }],
          },
        },
      });
      const eventExportPath = path.join(
        workspaceDir,
        "memory",
        "events",
        "memory-host-events.jsonl",
      );
      expect(artifacts).toEqual([
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
          relativePath: "memory/events/memory-host-events.jsonl",
          absolutePath: eventExportPath,
          agentIds: ["main"],
          contentType: "json",
        },
      ]);
      await expect(fs.readFile(eventExportPath, "utf8")).resolves.toBe(
        `${JSON.stringify({
          type: "memory.recall.recorded",
          timestamp: "2026-05-18T12:00:00.000Z",
          query: "bridge",
          resultCount: 0,
          results: [],
        })}\n`,
      );
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("does not let an older concurrent snapshot overwrite a newer event export", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-export-race-"));
    const workspaceDir = path.join(fixtureRoot, "workspace");
    const eventExportPath = path.join(workspaceDir, "memory", "events", "memory-host-events.jsonl");
    const cfg = {
      agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
    };
    const originalReadFile = fs.readFile.bind(fs);
    let releaseFirstRead: (() => void) | undefined;
    let signalFirstRead: (() => void) | undefined;
    let shouldBlockFirstRead = true;
    const firstReadStarted = new Promise<void>((resolve) => {
      signalFirstRead = resolve;
    });
    const readFileSpy = vi
      .spyOn(fs, "readFile")
      .mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
        const target = args[0];
        if (
          shouldBlockFirstRead &&
          typeof target === "string" &&
          path.resolve(target) === eventExportPath
        ) {
          shouldBlockFirstRead = false;
          signalFirstRead?.();
          await new Promise<void>((resolve) => {
            releaseFirstRead = resolve;
          });
        }
        return await originalReadFile(...args);
      });

    try {
      vi.stubEnv("OPENCLAW_STATE_DIR", fixtureRoot);
      await fs.mkdir(workspaceDir, { recursive: true });
      await appendMemoryHostEvent(workspaceDir, {
        type: "memory.recall.recorded",
        timestamp: "2026-05-18T12:00:00.000Z",
        query: "older",
        resultCount: 0,
        results: [],
      });
      const olderListing = listMemoryHostPublicArtifacts({ cfg });
      await firstReadStarted;

      await appendMemoryHostEvent(workspaceDir, {
        type: "memory.recall.recorded",
        timestamp: "2026-05-18T12:01:00.000Z",
        query: "newer",
        resultCount: 0,
        results: [],
      });
      const newerListing = listMemoryHostPublicArtifacts({ cfg });
      await Promise.race([
        newerListing,
        new Promise<void>((resolve) => {
          setTimeout(resolve, 250);
        }),
      ]);
      releaseFirstRead?.();
      await Promise.all([olderListing, newerListing]);

      const exported = (await fs.readFile(eventExportPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { query: string });
      expect(exported.map((event) => event.query)).toEqual(["older", "newer"]);
    } finally {
      releaseFirstRead?.();
      readFileSpy.mockRestore();
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("keeps the deprecated memory-core alias wired to memory-host-core", () => {
    expect(memoryCoreAlias.buildActiveMemoryPromptSection).toBe(buildActiveMemoryPromptSection);
    expect(memoryCoreAlias.listActiveMemoryPublicArtifacts).toBe(listActiveMemoryPublicArtifacts);
  });
});
