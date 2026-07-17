/**
 * Tests memory host core public artifact discovery and workspace handling.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
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

  it("propagates workspace inspection failures", async () => {
    vi.spyOn(fs, "stat").mockRejectedValueOnce(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );

    await expect(
      listMemoryHostPublicArtifacts({
        cfg: {
          agents: {
            list: [{ id: "main", default: true, workspace: "/protected/workspace" }],
          },
        },
      }),
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  it("lists readable workspaces without requiring workspace-root writes", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-readonly-workspace-"));
    const workspaceDir = path.join(fixtureRoot, "workspace");
    try {
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(fixtureRoot, "state"));
      await fs.mkdir(workspaceDir);
      await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Read-only memory\n", "utf8");
      await fs.chmod(workspaceDir, 0o500);

      await expect(
        listMemoryHostPublicArtifacts({
          cfg: {
            agents: {
              list: [{ id: "main", default: true, workspace: workspaceDir }],
            },
          },
        }),
      ).resolves.toMatchObject([
        {
          kind: "memory-root",
          workspaceDir,
          relativePath: "MEMORY.md",
        },
      ]);
    } finally {
      await fs.chmod(workspaceDir, 0o700).catch(() => undefined);
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "refuses to delete an event export through a symlinked parent",
    async () => {
      const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-export-symlink-"));
      const workspaceDir = path.join(fixtureRoot, "workspace");
      const externalMemoryDir = path.join(fixtureRoot, "external-memory");
      const externalExport = path.join(externalMemoryDir, "events", "memory-host-events.jsonl");
      try {
        vi.stubEnv("OPENCLAW_STATE_DIR", path.join(fixtureRoot, "state"));
        await fs.mkdir(workspaceDir);
        await fs.mkdir(path.dirname(externalExport), { recursive: true });
        await fs.writeFile(externalExport, '{"type":"external"}\n', "utf8");
        await fs.symlink(externalMemoryDir, path.join(workspaceDir, "memory"));

        await expect(
          listMemoryHostPublicArtifacts({
            cfg: {
              agents: {
                list: [{ id: "main", default: true, workspace: workspaceDir }],
              },
            },
          }),
        ).rejects.toThrow(/alias|symlink/u);
        await expect(fs.readFile(externalExport, "utf8")).resolves.toBe('{"type":"external"}\n');
      } finally {
        await fs.rm(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

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
      await expect(
        fs.access(path.join(workspaceDir, ".memory-host-events-export.lock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await fs.readdir(fixtureRoot)).some((entry) =>
          entry.startsWith(".memory-host-events-export-"),
        ),
      ).toBe(false);

      await createPluginStateKeyedStore("memory-core", {
        namespace: "memory-host.events",
        maxEntries: 10_000,
        env: { ...process.env, OPENCLAW_STATE_DIR: fixtureRoot },
      }).clear();
      const afterRetention = await listMemoryHostPublicArtifacts({
        cfg: {
          agents: {
            list: [{ id: "main", default: true, workspace: workspaceDir }],
          },
        },
      });
      expect(afterRetention.some((artifact) => artifact.kind === "event-log")).toBe(false);
      await expect(fs.access(eventExportPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "does not let a workspace alias overwrite a newer event export",
    async () => {
      const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-export-race-"));
      const workspaceDir = path.join(fixtureRoot, "workspace");
      const eventExportPath = path.join(
        workspaceDir,
        "memory",
        "events",
        "memory-host-events.jsonl",
      );
      const workspaceAlias = path.join(fixtureRoot, "workspace-alias");
      const cfg = {
        agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
      };
      const aliasCfg = {
        agents: { list: [{ id: "main", default: true, workspace: workspaceAlias }] },
      };
      const originalOpen = fs.open.bind(fs);
      let releaseFirstRead: (() => void) | undefined;
      let signalFirstRead: (() => void) | undefined;
      let shouldBlockFirstRead = true;
      const firstReadStarted = new Promise<void>((resolve) => {
        signalFirstRead = resolve;
      });
      const openSpy = vi
        .spyOn(fs, "open")
        .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
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
          return await originalOpen(...args);
        });

      try {
        vi.stubEnv("OPENCLAW_STATE_DIR", fixtureRoot);
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.symlink(workspaceDir, workspaceAlias);
        await appendMemoryHostEvent(workspaceAlias, {
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
        const newerListing = listMemoryHostPublicArtifacts({ cfg: aliasCfg });
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
        openSpy.mockRestore();
        await fs.rm(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  it("keeps the deprecated memory-core alias wired to memory-host-core", () => {
    expect(memoryCoreAlias.buildActiveMemoryPromptSection).toBe(buildActiveMemoryPromptSection);
    expect(memoryCoreAlias.listActiveMemoryPublicArtifacts).toBe(listActiveMemoryPublicArtifacts);
  });
});
