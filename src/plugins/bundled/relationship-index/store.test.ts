import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RelationshipEdge } from "../../../sre/contracts/entity.js";
import {
  appendRelationshipIndexUpdate,
  resolveRelationshipIndexStorePaths,
  type RelationshipIndexNode,
} from "./store.js";

const tempRoots: string[] = [];

async function createStateEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-relationship-index-"));
  tempRoots.push(root);
  return { OPENCLAW_STATE_DIR: root };
}

async function readNdjson(filePath: string): Promise<string[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw.split("\n").filter(Boolean);
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("relationship index store", () => {
  it("merges latest-by-entity across multiple appends", async () => {
    const env = await createStateEnv();
    const paths = resolveRelationshipIndexStorePaths(env);

    await appendRelationshipIndexUpdate(
      {
        nodes: [
          {
            version: "sre.relationship-index-node.v1",
            entityId: "message:1",
            entityType: "message",
            observedAt: "2026-03-07T15:30:00.000Z",
          },
        ],
        edges: [],
      },
      { env },
    );
    await appendRelationshipIndexUpdate(
      {
        nodes: [
          {
            version: "sre.relationship-index-node.v1",
            entityId: "thread:1",
            entityType: "thread",
            observedAt: "2026-03-07T15:31:00.000Z",
          },
        ],
        edges: [],
      },
      { env },
    );

    const latest = JSON.parse(await fs.readFile(paths.latestByEntityPath, "utf8")) as {
      nodes: Record<string, RelationshipIndexNode>;
    };
    expect(Object.keys(latest.nodes).toSorted()).toEqual(["message:1", "thread:1"]);
  });

  it("skips corrupt NDJSON lines during compaction instead of crashing", async () => {
    const env = await createStateEnv();
    const paths = resolveRelationshipIndexStorePaths(env);

    const validNode: RelationshipIndexNode = {
      version: "sre.relationship-index-node.v1",
      entityId: "message:valid",
      entityType: "message",
      observedAt: "2026-03-17T10:00:00.000Z",
    };

    // Write one valid append to create the directory and files
    await appendRelationshipIndexUpdate(
      { nodes: [validNode], edges: [] },
      { env, compactAfterBytes: 1 },
    );

    // Inject a corrupt line into the nodes file
    const nodesContent = await fs.readFile(paths.nodesPath, "utf8");
    await fs.writeFile(
      paths.nodesPath,
      nodesContent + '{"entityId":"message:corrupt","broken json\n',
      "utf8",
    );

    // Next append should not throw — corrupt line is skipped during compaction
    await appendRelationshipIndexUpdate(
      {
        nodes: [
          {
            version: "sre.relationship-index-node.v1",
            entityId: "message:after",
            entityType: "message",
            observedAt: "2026-03-17T10:01:00.000Z",
          },
        ],
        edges: [],
      },
      { env, compactAfterBytes: 1 },
    );

    const finalLines = await readNdjson(paths.nodesPath);
    const entityIds = finalLines.map((l) => (JSON.parse(l) as { entityId: string }).entityId);
    expect(entityIds).toContain("message:valid");
    expect(entityIds).toContain("message:after");
    expect(entityIds).not.toContain("message:corrupt");
  });

  it("compacts duplicate nodes and edges after the threshold is exceeded", async () => {
    const env = await createStateEnv();
    const paths = resolveRelationshipIndexStorePaths(env);
    const node: RelationshipIndexNode = {
      version: "sre.relationship-index-node.v1",
      entityId: "message:dup",
      entityType: "message",
      observedAt: "2026-03-07T15:32:00.000Z",
    };
    const edge: RelationshipEdge = {
      version: "sre.relationship-edge.v1",
      edgeId: "edge:dup",
      from: "message:dup",
      to: "thread:dup",
      edgeType: "belongs_to",
      discoveredAt: "2026-03-07T15:32:00.000Z",
      provenance: [],
    };

    await appendRelationshipIndexUpdate(
      { nodes: [node], edges: [edge] },
      { env, compactAfterBytes: 1 },
    );
    await appendRelationshipIndexUpdate(
      { nodes: [node], edges: [edge] },
      { env, compactAfterBytes: 1 },
    );

    expect(await readNdjson(paths.nodesPath)).toHaveLength(1);
    expect(await readNdjson(paths.edgesPath)).toHaveLength(1);
  });

  it("serializes concurrent appends so latest-by-entity does not lose updates", async () => {
    const env = await createStateEnv();
    const paths = resolveRelationshipIndexStorePaths(env);
    const firstLatestWriteStarted = createDeferred<void>();
    const releaseFirstLatestWrite = createDeferred<void>();
    const originalWriteFile = fs.writeFile.bind(fs) as (
      ...args: Parameters<typeof fs.writeFile>
    ) => ReturnType<typeof fs.writeFile>;
    const originalRename = fs.rename.bind(fs) as (
      ...args: Parameters<typeof fs.rename>
    ) => ReturnType<typeof fs.rename>;
    let blockedFirstLatestWrite = false;

    vi.spyOn(fs, "writeFile").mockImplementation(
      async (...args: Parameters<typeof fs.writeFile>) => {
        return originalWriteFile(...args);
      },
    );

    // Block on the atomic rename for the latest-by-entity file
    vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      const [, dest] = args;
      if (
        !blockedFirstLatestWrite &&
        typeof dest === "string" &&
        dest === paths.latestByEntityPath
      ) {
        blockedFirstLatestWrite = true;
        firstLatestWriteStarted.resolve(undefined);
        await releaseFirstLatestWrite.promise;
      }
      return originalRename(...args);
    });

    const firstAppend = appendRelationshipIndexUpdate(
      {
        nodes: [
          {
            version: "sre.relationship-index-node.v1",
            entityId: "message:concurrent-1",
            entityType: "message",
            observedAt: "2026-03-07T15:33:00.000Z",
          },
        ],
        edges: [],
      },
      { env },
    );
    await firstLatestWriteStarted.promise;

    const secondAppend = appendRelationshipIndexUpdate(
      {
        nodes: [
          {
            version: "sre.relationship-index-node.v1",
            entityId: "thread:concurrent-2",
            entityType: "thread",
            observedAt: "2026-03-07T15:34:00.000Z",
          },
        ],
        edges: [],
      },
      { env },
    );

    releaseFirstLatestWrite.resolve(undefined);
    await Promise.all([firstAppend, secondAppend]);

    const latest = JSON.parse(await fs.readFile(paths.latestByEntityPath, "utf8")) as {
      nodes: Record<string, RelationshipIndexNode>;
    };
    expect(Object.keys(latest.nodes).toSorted()).toEqual([
      "message:concurrent-1",
      "thread:concurrent-2",
    ]);
    expect(await readNdjson(paths.nodesPath)).toHaveLength(2);
  });

  it("quarantines truncated latest-by-entity.json instead of error-looping", async () => {
    const env = await createStateEnv();
    const paths = resolveRelationshipIndexStorePaths(env);

    // Create the state directory
    await fs.mkdir(path.dirname(paths.latestByEntityPath), { recursive: true });

    // Write a truncated JSON file (simulating crash at 1 MiB boundary)
    await fs.writeFile(
      paths.latestByEntityPath,
      '{"version":"sre.relationship-index-latest.v1","updatedAt":"2026-03-16T17:00:00Z","nodes":{"msg:1":{"entit',
      "utf8",
    );

    // First append should succeed — corrupt file is quarantined, not re-thrown
    await appendRelationshipIndexUpdate(
      {
        nodes: [
          {
            version: "sre.relationship-index-node.v1",
            entityId: "message:recovery",
            entityType: "message",
            observedAt: "2026-03-24T08:00:00.000Z",
          },
        ],
        edges: [],
      },
      { env },
    );

    // Verify the new snapshot is valid
    const latest = JSON.parse(await fs.readFile(paths.latestByEntityPath, "utf8")) as {
      nodes: Record<string, RelationshipIndexNode>;
    };
    expect(latest.nodes["message:recovery"]).toBeDefined();

    // Verify the corrupt file was quarantined (not deleted)
    const files = await fs.readdir(path.dirname(paths.latestByEntityPath));
    const quarantined = files.filter((f) => f.startsWith(".quarantine.latest-by-entity.json."));
    expect(quarantined).toHaveLength(1);
  });

  it("quarantines majority-corrupt NDJSON files during compaction", async () => {
    const env = await createStateEnv();
    const paths = resolveRelationshipIndexStorePaths(env);

    // Create the directory and write a mostly-corrupt edges file
    await fs.mkdir(path.dirname(paths.edgesPath), { recursive: true });

    const validEdge = JSON.stringify({
      version: "sre.relationship-edge.v1",
      edgeId: "edge:valid",
      from: "a",
      to: "b",
      edgeType: "belongs_to",
      discoveredAt: "2026-03-24T08:00:00Z",
      provenance: [],
    });
    // 1 valid line, 3 corrupt lines → majority corrupt
    const corruptContent =
      [
        validEdge,
        "\x00\x00\x00\x00\x00\x00\x00\x00",
        '{"edgeId":"edge:broken","incomplete',
        "\x00\x00\x00\x00",
      ].join("\n") + "\n";

    await fs.writeFile(paths.edgesPath, corruptContent, "utf8");

    // Write a valid nodes file above compact threshold
    const validNode: RelationshipIndexNode = {
      version: "sre.relationship-index-node.v1",
      entityId: "message:compact-test",
      entityType: "message",
      observedAt: "2026-03-24T08:00:00.000Z",
    };
    await fs.writeFile(paths.nodesPath, JSON.stringify(validNode) + "\n", "utf8");

    // Append triggers compaction (threshold=1) which reads the corrupt edges file
    await appendRelationshipIndexUpdate(
      { nodes: [validNode], edges: [] },
      { env, compactAfterBytes: 1 },
    );

    // The corrupt edges file should have been quarantined
    const files = await fs.readdir(path.dirname(paths.edgesPath));
    const quarantined = files.filter((f) => f.startsWith(".quarantine.edges.ndjson."));
    expect(quarantined).toHaveLength(1);
  });

  it("does not quarantine duplicate-key NDJSON when most parsed lines are valid", async () => {
    const env = await createStateEnv();
    const paths = resolveRelationshipIndexStorePaths(env);

    await fs.mkdir(path.dirname(paths.nodesPath), { recursive: true });

    const duplicateNodes = Array.from({ length: 6 }, (_, index) =>
      JSON.stringify({
        version: "sre.relationship-index-node.v1",
        entityId: `message:${index % 2}`,
        entityType: "message",
        observedAt: `2026-03-24T08:00:0${index}.000Z`,
      }),
    );
    const mixedContent =
      [
        ...duplicateNodes,
        '{"entityId":"message:broken","incomplete',
        "\x00\x00\x00\x00",
        '{"entityId":"message:broken-2","oops',
      ].join("\n") + "\n";
    await fs.writeFile(paths.nodesPath, mixedContent, "utf8");

    const validEdge: RelationshipEdge = {
      version: "sre.relationship-edge.v1",
      edgeId: "edge:trigger",
      from: "message:0",
      to: "thread:trigger",
      edgeType: "belongs_to",
      discoveredAt: "2026-03-24T08:00:00Z",
      provenance: [],
    };

    await appendRelationshipIndexUpdate(
      { nodes: [], edges: [validEdge] },
      { env, compactAfterBytes: 1 },
    );

    const files = await fs.readdir(path.dirname(paths.nodesPath));
    const quarantined = files.filter((f) => f.startsWith(".quarantine.nodes.ndjson."));
    expect(quarantined).toHaveLength(0);
    expect(await readNdjson(paths.nodesPath)).toHaveLength(2);
  });

  it("writes latest-by-entity.json atomically via temp file + rename", async () => {
    const env = await createStateEnv();
    const paths = resolveRelationshipIndexStorePaths(env);
    const originalRename = fs.rename.bind(fs) as (
      ...args: Parameters<typeof fs.rename>
    ) => ReturnType<typeof fs.rename>;
    const renamedPairs: Array<{ from: string; to: string }> = [];

    vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      const [src, dest] = args;
      if (typeof dest === "string" && dest === paths.latestByEntityPath) {
        renamedPairs.push({ from: String(src), to: dest });
      }
      return originalRename(...args);
    });

    await appendRelationshipIndexUpdate(
      {
        nodes: [
          {
            version: "sre.relationship-index-node.v1",
            entityId: "message:atomic",
            entityType: "message",
            observedAt: "2026-03-24T08:00:00.000Z",
          },
        ],
        edges: [],
      },
      { env },
    );

    // Verify that the write went through a temp file rename
    expect(renamedPairs.length).toBeGreaterThanOrEqual(1);
    const lastRename = renamedPairs[renamedPairs.length - 1];
    expect(lastRename.from).toMatch(/\.tmp\.latest-by-entity\.json\.\d+\.\d+/);
    expect(lastRename.to).toBe(paths.latestByEntityPath);

    // Verify final file is valid JSON
    const latest = JSON.parse(await fs.readFile(paths.latestByEntityPath, "utf8")) as {
      nodes: Record<string, RelationshipIndexNode>;
    };
    expect(latest.nodes["message:atomic"]).toBeDefined();
  });

  it("second append after quarantine rebuilds snapshot from scratch", async () => {
    const env = await createStateEnv();
    const paths = resolveRelationshipIndexStorePaths(env);

    await fs.mkdir(path.dirname(paths.latestByEntityPath), { recursive: true });

    // Write truncated snapshot
    await fs.writeFile(paths.latestByEntityPath, '{"version":"sre.relat', "utf8");

    // First append quarantines and rebuilds
    await appendRelationshipIndexUpdate(
      {
        nodes: [
          {
            version: "sre.relationship-index-node.v1",
            entityId: "message:first",
            entityType: "message",
            observedAt: "2026-03-24T08:00:00.000Z",
          },
        ],
        edges: [],
      },
      { env },
    );

    // Second append merges correctly with the rebuilt snapshot
    await appendRelationshipIndexUpdate(
      {
        nodes: [
          {
            version: "sre.relationship-index-node.v1",
            entityId: "message:second",
            entityType: "message",
            observedAt: "2026-03-24T08:01:00.000Z",
          },
        ],
        edges: [],
      },
      { env },
    );

    const latest = JSON.parse(await fs.readFile(paths.latestByEntityPath, "utf8")) as {
      nodes: Record<string, RelationshipIndexNode>;
    };
    expect(Object.keys(latest.nodes).toSorted()).toEqual(["message:first", "message:second"]);
  });
});
