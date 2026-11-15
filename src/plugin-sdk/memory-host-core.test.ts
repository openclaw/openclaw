import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createPluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import { clearMemoryPluginState } from "../plugins/memory-state.test-fixtures.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { listMemoryHostPublicArtifacts } from "./memory-host-core.js";
import { appendMemoryHostEvent } from "./memory-host-events.js";

async function createFixtureRoot(prefix: string): Promise<string> {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

function workspaceConfig(workspaceDir: string) {
  return { agents: { entries: { main: { workspace: workspaceDir } } } };
}

function recallEvent(query: string, timestamp = "2026-05-18T12:00:00.000Z") {
  return { type: "memory.recall.recorded" as const, timestamp, query, resultCount: 0, results: [] };
}

async function directoryHash(directory: string) {
  return createHash("sha256")
    .update(await fs.realpath(directory))
    .digest("hex")
    .slice(0, 32);
}

describe("memory-host-core helpers", () => {
  let fixtureRoot: string;
  let workspaceDir: string;
  let cfg: ReturnType<typeof workspaceConfig>;
  beforeEach(async () => {
    fixtureRoot = await createFixtureRoot("memory-host-core-");
    workspaceDir = path.join(fixtureRoot, "workspace");
    cfg = workspaceConfig(workspaceDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", fixtureRoot);
    await fs.mkdir(workspaceDir);
  });
  const listArtifacts = () => listMemoryHostPublicArtifacts({ cfg });
  const resolveExpectedExportPath = async (
    stateDir = fixtureRoot,
    memoryDir = path.join(workspaceDir, "memory"),
  ) => path.join(memoryDir, "events", await directoryHash(stateDir), "memory-host-events.jsonl");
  async function requireExportPath() {
    const artifact = (await listArtifacts()).find((entry) => entry.kind === "event-log");
    if (!artifact) {
      throw new Error("expected memory event export");
    }
    return artifact.absolutePath;
  }
  async function clearStoredEvents() {
    await createPluginStateKeyedStore("memory-core", {
      namespace: "memory-host.events",
      maxEntries: 10_000,
      env: { ...process.env, OPENCLAW_STATE_DIR: fixtureRoot },
    }).clear();
  }
  function onExportOpen(exportPath: string, at: number, effect: () => Promise<void>) {
    const open = fs.open.bind(fs);
    let count = 0;
    return vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const target = args[0];
      if (typeof target === "string" && path.resolve(target) === path.resolve(exportPath)) {
        if (++count === at) {
          await effect();
        }
      }
      return open(...args);
    });
  }
  async function prepareExport(clear = false) {
    await appendMemoryHostEvent(workspaceDir, recallEvent("first"));
    const filePath = await requireExportPath();
    if (clear) {
      await clearStoredEvents();
    } else {
      await appendMemoryHostEvent(workspaceDir, recallEvent("second", "2026-05-18T12:01:00.000Z"));
    }
    return filePath;
  }
  afterEach(async () => {
    clearMemoryPluginState();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("propagates workspace inspection failures", async () => {
    vi.spyOn(fs, "stat").mockRejectedValueOnce(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );

    await expect(
      listMemoryHostPublicArtifacts({
        cfg: workspaceConfig("/protected/workspace"),
      }),
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  it("lists readable workspaces without requiring workspace-root writes", async () => {
    try {
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(fixtureRoot, "state"));
      await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Read-only memory\n", "utf8");
      await appendMemoryHostEvent(workspaceDir, recallEvent("read-only"));
      await fs.chmod(workspaceDir, 0o500);

      await expect(listArtifacts()).resolves.toMatchObject([
        {
          kind: "memory-root",
          workspaceDir,
          relativePath: "MEMORY.md",
        },
      ]);
    } finally {
      await fs.chmod(workspaceDir, 0o700).catch(() => undefined);
    }
  });

  it.runIf(process.platform !== "win32")(
    "propagates failures reading an existing event export",
    async () => {
      let eventExportPath: string | undefined;
      try {
        vi.stubEnv("OPENCLAW_STATE_DIR", path.join(fixtureRoot, "state"));
        await appendMemoryHostEvent(workspaceDir, recallEvent("unreadable export"));
        eventExportPath = await requireExportPath();
        await fs.chmod(eventExportPath, 0o000);

        await expect(listArtifacts()).rejects.toThrow();
      } finally {
        if (eventExportPath) {
          await fs.chmod(eventExportPath, 0o600).catch(() => undefined);
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not delete an event export through a symlinked parent",
    async () => {
      const externalMemoryDir = path.join(fixtureRoot, "external-memory");
      const stateDir = path.join(fixtureRoot, "state");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      await fs.mkdir(stateDir);
      const externalExport = await resolveExpectedExportPath(stateDir, externalMemoryDir);
      const externalOwner = path.join(
        path.dirname(externalExport),
        ".openclaw-memory-host-events-owner.json",
      );
      await fs.mkdir(path.dirname(externalExport), { recursive: true });
      await fs.writeFile(externalExport, '{"type":"external"}\n', "utf8");
      await fs.writeFile(externalOwner, '{"kind":"external"}\n', "utf8");
      await fs.writeFile(path.join(externalMemoryDir, "public.md"), "# Public memory\n");
      await fs.symlink(externalMemoryDir, path.join(workspaceDir, "memory"));

      await expect(listArtifacts()).resolves.toEqual([
        {
          kind: "daily-note",
          workspaceDir,
          relativePath: "memory/public.md",
          absolutePath: path.join(workspaceDir, "memory", "public.md"),
          agentIds: ["main"],
          contentType: "markdown",
        },
      ]);
      await expect(fs.readFile(externalExport, "utf8")).resolves.toBe('{"type":"external"}\n');
      await expect(fs.readFile(externalOwner, "utf8")).resolves.toBe('{"kind":"external"}\n');
    },
  );

  it("does not replace or delete an unowned event export path", async () => {
    await appendMemoryHostEvent(workspaceDir, recallEvent("must not replace user file"));
    const exportPath = await resolveExpectedExportPath();
    await fs.mkdir(path.dirname(exportPath), { recursive: true });
    await fs.writeFile(exportPath, '{"owner":"user"}\n', "utf8");

    const listed = await listArtifacts();
    expect(listed.some((artifact) => artifact.kind === "event-log")).toBe(false);
    await expect(fs.readFile(exportPath, "utf8")).resolves.toBe('{"owner":"user"}\n');

    await clearStoredEvents();
    await listArtifacts();
    await expect(fs.readFile(exportPath, "utf8")).resolves.toBe('{"owner":"user"}\n');
  });

  it("does not let an orphaned owner marker authorize a later workspace file", async () => {
    const stateDir = path.join(fixtureRoot, "state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await appendMemoryHostEvent(workspaceDir, recallEvent("expected export"));
    const stateHash = await directoryHash(stateDir);
    const workspaceHash = await directoryHash(workspaceDir);
    const exportDir = path.join(workspaceDir, "memory", "events", stateHash);
    const exportPath = path.join(exportDir, "memory-host-events.jsonl");
    const ownerPath = path.join(exportDir, ".openclaw-memory-host-events-owner.json");
    const expectedContent = `${JSON.stringify(recallEvent("expected export"))}\n`;
    await fs.mkdir(exportDir, { recursive: true });
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
    await fs.writeFile(exportPath, '{"owner":"user after crash"}\n', "utf8");

    const listed = await listArtifacts();

    expect(listed.some((artifact) => artifact.kind === "event-log")).toBe(false);
    await expect(fs.readFile(exportPath, "utf8")).resolves.toBe('{"owner":"user after crash"}\n');
  });

  it("does not claim a same-content inode that replaces an exclusive export", async () => {
    const event = recallEvent("exclusive create");
    const expectedContent = `${JSON.stringify(event)}\n`;
    const originalOpen = fs.open.bind(fs);
    await appendMemoryHostEvent(workspaceDir, event);
    const exportPath = await resolveExpectedExportPath();
    onExportOpen(exportPath, 4, async () => {
      await fs.rename(exportPath, `${exportPath}.openclaw-created`);
      const replacement = await originalOpen(exportPath, "wx", 0o600);
      try {
        await replacement.writeFile(expectedContent, "utf8");
      } finally {
        await replacement.close();
      }
    });

    const racedArtifacts = await listArtifacts();
    expect(racedArtifacts.some((artifact) => artifact.kind === "event-log")).toBe(false);
    await expect(fs.readFile(exportPath, "utf8")).resolves.toBe(expectedContent);

    vi.restoreAllMocks();
    await appendMemoryHostEvent(workspaceDir, { ...event, query: "must stay foreign" });
    const retriedArtifacts = await listArtifacts();
    expect(retriedArtifacts.some((artifact) => artifact.kind === "event-log")).toBe(false);
    await expect(fs.readFile(exportPath, "utf8")).resolves.toBe(expectedContent);
  });

  it("omits the event export when a workspace path component is a file", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(fixtureRoot, "state"));
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Still visible\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, "memory"), "user file\n", "utf8");
    await appendMemoryHostEvent(workspaceDir, recallEvent("blocked export"));

    await expect(listArtifacts()).resolves.toEqual([
      expect.objectContaining({ kind: "memory-root", relativePath: "MEMORY.md" }),
    ]);
    await expect(fs.readFile(path.join(workspaceDir, "memory"), "utf8")).resolves.toBe(
      "user file\n",
    );
  });

  it("lists shared public artifacts from memory workspaces", async () => {
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Durable Memory\n", "utf8");
    expect((await listArtifacts()).map((artifact) => artifact.relativePath)).toEqual(["MEMORY.md"]);

    const memoryDir = path.join(workspaceDir, "memory");
    for (const relativePath of [
      "nested/inner.md",
      "dreaming/2026-05-18.md",
      "2026-05-18.md",
      ".notes/retained.md",
      ".hidden.md",
      "UPPER.MD",
      "notes.txt",
      "unreadable/omitted.md",
    ]) {
      const file = path.join(memoryDir, relativePath);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `# ${relativePath}\n`);
    }
    const outsideDir = path.join(fixtureRoot, "outside");
    await fs.mkdir(outsideDir);
    await fs.writeFile(path.join(outsideDir, "linked.md"), "# Outside memory\n");
    await fs.symlink(
      outsideDir,
      path.join(memoryDir, "linked-directory"),
      process.platform === "win32" ? "junction" : "dir",
    );
    if (process.platform !== "win32") {
      await fs.symlink(path.join(outsideDir, "linked.md"), path.join(memoryDir, "linked.md"));
    }
    let unreadableDirectory = path.join(memoryDir, "unreadable");
    const readdir = fs.readdir;
    vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      const directory = String(args[0]);
      if (
        directory === unreadableDirectory ||
        directory === path.toNamespacedPath(unreadableDirectory)
      ) {
        throw Object.assign(new Error("fixture directory is unreadable"), { code: "EACCES" });
      }
      return readdir(...args);
    });
    const eventStoredAt = Date.parse("2026-05-19T09:30:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(eventStoredAt);
    await appendMemoryHostEvent(workspaceDir, recallEvent("bridge"));

    const artifacts = await listArtifacts();
    const eventArtifact = artifacts.find((artifact) => artifact.kind === "event-log");
    if (!eventArtifact) {
      throw new Error("expected memory event export");
    }
    expect(artifacts.filter((artifact) => artifact.kind !== "event-log")).toEqual(
      [
        { kind: "memory-root", relativePath: "MEMORY.md" },
        { kind: "daily-note", relativePath: "memory/.hidden.md" },
        { kind: "daily-note", relativePath: "memory/.notes/retained.md" },
        { kind: "daily-note", relativePath: "memory/2026-05-18.md" },
        { kind: "dream-report", relativePath: "memory/dreaming/2026-05-18.md" },
        { kind: "daily-note", relativePath: "memory/nested/inner.md" },
      ].map(({ kind, relativePath }) => ({
        kind,
        relativePath,
        workspaceDir,
        absolutePath: path.join(workspaceDir, ...relativePath.split("/")),
        agentIds: ["main"],
        contentType: "markdown",
      })),
    );
    expect(eventArtifact).toMatchObject({
      kind: "event-log",
      workspaceDir,
      agentIds: ["main"],
      contentType: "json",
    });
    expect(eventArtifact.relativePath).toMatch(
      /^memory\/events\/[a-f0-9]{32}\/memory-host-events\.jsonl$/u,
    );
    expect(eventArtifact.absolutePath).toBe(
      path.join(workspaceDir, ...eventArtifact.relativePath.split("/")),
    );
    const eventExportPath = eventArtifact.absolutePath;
    await expect(fs.readFile(eventExportPath, "utf8")).resolves.toBe(
      `${JSON.stringify(recallEvent("bridge"))}\n`,
    );
    const exportStat = await fs.stat(eventExportPath, { bigint: true });
    const exportOwner = JSON.parse(
      await fs.readFile(
        path.join(path.dirname(eventExportPath), ".openclaw-memory-host-events-owner.json"),
        "utf8",
      ),
    ) as { fileDev?: string; fileIno?: string };
    expect(exportOwner.fileDev).toBe(String(exportStat.dev));
    expect(exportOwner.fileIno).toBe(String(exportStat.ino));
    await expect(
      fs.access(path.join(workspaceDir, ".memory-host-events-export.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await fs.readdir(fixtureRoot)).some((entry) =>
        entry.startsWith(".memory-host-events-export-"),
      ),
    ).toBe(false);

    await clearStoredEvents();
    const afterRetention = await listArtifacts();
    expect(afterRetention.some((artifact) => artifact.kind === "event-log")).toBe(false);
    await expect(fs.readFile(eventExportPath, "utf8")).resolves.toBe("");
    unreadableDirectory = memoryDir;
    expect((await listArtifacts()).map((artifact) => artifact.relativePath)).toEqual(["MEMORY.md"]);
  });

  it.runIf(process.platform !== "win32")(
    "does not let a workspace alias overwrite a newer event export",
    async () => {
      const workspaceAlias = path.join(fixtureRoot, "workspace-alias");
      const aliasCfg = workspaceConfig(workspaceAlias);
      const firstRead = createDeferred();
      const releaseFirstRead = createDeferred();
      const openSpy = onExportOpen(await resolveExpectedExportPath(), 1, async () => {
        firstRead.resolve();
        await releaseFirstRead.promise;
      });

      try {
        await fs.symlink(workspaceDir, workspaceAlias);
        await appendMemoryHostEvent(workspaceAlias, recallEvent("older"));
        const olderListing = listArtifacts();
        await firstRead.promise;

        await appendMemoryHostEvent(workspaceDir, recallEvent("newer", "2026-05-18T12:01:00.000Z"));
        const newerListing = listMemoryHostPublicArtifacts({ cfg: aliasCfg });
        await Promise.race([
          newerListing,
          new Promise<void>((resolve) => {
            setTimeout(resolve, 250);
          }),
        ]);
        releaseFirstRead.resolve();
        const [olderArtifacts, newerArtifacts] = await Promise.all([olderListing, newerListing]);
        const olderExport = olderArtifacts.find((artifact) => artifact.kind === "event-log");
        const newerExport = newerArtifacts.find((artifact) => artifact.kind === "event-log");
        expect(olderExport?.absolutePath).toBe(newerExport?.absolutePath);
        const eventExportPath = newerExport?.absolutePath;
        if (!eventExportPath) {
          throw new Error("expected memory event export");
        }

        const exported = (await fs.readFile(eventExportPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { query: string });
        expect(exported.map((event) => event.query)).toEqual(["older", "newer"]);
      } finally {
        releaseFirstRead.resolve();
        openSpy.mockRestore();
      }
    },
  );

  it.each([
    { name: "refresh", clearEvents: false },
    { name: "retirement", clearEvents: true },
  ])("preserves a replacement installed during event export $name", async ({ clearEvents }) => {
    const replacement = '{"owner":"workspace"}\n';
    const expectedExportPath = await prepareExport(clearEvents);
    onExportOpen(expectedExportPath, 2, async () => {
      await fs.rename(expectedExportPath, `${expectedExportPath}.openclaw-owned`);
      await fs.writeFile(expectedExportPath, replacement, "utf8");
    });

    const artifacts = await listArtifacts();
    expect(artifacts.some((artifact) => artifact.kind === "event-log")).toBe(false);
    await expect(fs.readFile(expectedExportPath, "utf8")).resolves.toBe(replacement);
  });

  it.each([
    { name: "refresh", clearEvents: false },
    { name: "retirement", clearEvents: true },
  ])("keeps ownership through same-inode event export $name", async ({ clearEvents }) => {
    const originalOpen = fs.open.bind(fs);
    const expectedExportPath = await prepareExport(clearEvents);
    const originalStat = await fs.stat(expectedExportPath);
    onExportOpen(expectedExportPath, 2, async () => {
      const writer = await originalOpen(expectedExportPath, "w");
      try {
        await writer.writeFile('{"owner":"same inode"}\n', "utf8");
      } finally {
        await writer.close();
      }
    });

    const artifacts = await listArtifacts();
    expect((await fs.stat(expectedExportPath)).ino).toBe(originalStat.ino);
    if (clearEvents) {
      expect(artifacts.some((artifact) => artifact.kind === "event-log")).toBe(false);
      await expect(fs.readFile(expectedExportPath, "utf8")).resolves.toBe("");
    } else {
      expect(artifacts.some((artifact) => artifact.kind === "event-log")).toBe(true);
      await expect(fs.readFile(expectedExportPath, "utf8")).resolves.toContain("second");
    }
  });

  it("retries an owned event export after a same-inode post-write race", async () => {
    const originalOpen = fs.open.bind(fs);
    const expectedExportPath = await prepareExport();
    const openSpy = onExportOpen(expectedExportPath, 4, async () => {
      const writer = await originalOpen(expectedExportPath, "w");
      try {
        await writer.writeFile('{"owner":"post-write race"}\n', "utf8");
      } finally {
        await writer.close();
      }
    });

    const racedArtifacts = await listArtifacts();
    expect(racedArtifacts.some((artifact) => artifact.kind === "event-log")).toBe(false);
    openSpy.mockRestore();

    const retriedArtifacts = await listArtifacts();
    expect(retriedArtifacts.some((artifact) => artifact.kind === "event-log")).toBe(true);
    await expect(fs.readFile(expectedExportPath, "utf8")).resolves.toContain("second");
  });

  it("repairs an oversized owned event export by inode", async () => {
    await appendMemoryHostEvent(workspaceDir, recallEvent("first"));
    const eventExportPath = await requireExportPath();
    const originalStat = await fs.stat(eventExportPath);
    await fs.appendFile(eventExportPath, "x".repeat(1024 * 1024 + 1), "utf8");
    await appendMemoryHostEvent(workspaceDir, recallEvent("second", "2026-05-18T12:01:00.000Z"));

    const artifacts = await listArtifacts();
    expect(artifacts.some((artifact) => artifact.kind === "event-log")).toBe(true);
    expect((await fs.stat(eventExportPath)).ino).toBe(originalStat.ino);
    expect((await fs.stat(eventExportPath)).size).toBeLessThan(1024 * 1024);
    await expect(fs.readFile(eventExportPath, "utf8")).resolves.toContain("second");
  });

  it("keeps public event exports isolated across state directories", async () => {
    const exports: string[] = [];
    for (const profile of ["profile-a", "profile-b"]) {
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(fixtureRoot, profile));
      await appendMemoryHostEvent(workspaceDir, recallEvent(profile));
      const artifact = (await listArtifacts()).find((candidate) => candidate.kind === "event-log");
      if (!artifact) {
        throw new Error("expected memory event export");
      }
      exports.push(artifact.absolutePath);
      await expect(fs.readFile(artifact.absolutePath, "utf8")).resolves.toContain(profile);
    }

    expect(new Set(exports).size).toBe(2);
    const [profileAExport, profileBExport] = exports;
    if (!profileAExport || !profileBExport) {
      throw new Error("expected state-qualified memory event exports");
    }
    await expect(fs.readFile(profileAExport, "utf8")).resolves.toContain("profile-a");
    await expect(fs.readFile(profileBExport, "utf8")).resolves.toContain("profile-b");
  });
});
