import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { registerAgentWorkspaceAccess } from "../agents/workspace-access.js";
import { createWorkspaceMemoryFileClient } from "../agents/workspace-memory-client.js";
import * as pluginState from "../plugin-state/plugin-state-store.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  clearMemoryArtifactProvenance as clear,
  listMemoryArtifactProvenance as list,
  normalizeMemoryArtifactRelativePath as normalizePath,
  readMemoryArtifactProvenance as read,
  recordCuratedMemoryArtifactRewrite as rewrite,
  recordMemoryArtifactWriteProvenance as recordWrite,
} from "./memory-artifact-provenance.js";

type Address = Parameters<typeof read>[0];
const test = it.extend<{ tempRoot: string; address: Address }>({
  tempRoot: async ({ task }, use) =>
    withStateDirEnv(`openclaw-memory-artifact-${task.id}-`, ({ tempRoot }) => use(tempRoot)),
  address: async ({ tempRoot }, use) => use({ workspaceDir: tempRoot, relativePath: "MEMORY.md" }),
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginStateStoreForTests();
});

function write(
  address: Address,
  contentBefore: string,
  contentAfter: string,
  observedAt: number,
  originClass: "agent" | "untrusted" = "agent",
) {
  return recordWrite({ ...address, contentBefore, contentAfter, observedAt, originClass });
}

function beforeNextPersist(before: () => Promise<void>) {
  const next = vi.fn().mockImplementationOnce(before);
  const createStore = pluginState.createCorePluginStateKeyedStore;
  vi.spyOn(pluginState, "createCorePluginStateKeyedStore").mockImplementation((options) => {
    const store = createStore(options);
    return {
      ...store,
      compareAndApply: async (...args) => {
        await next();
        return store.compareAndApply(...args);
      },
    };
  });
}

async function expectOrigin(address: Address, originClass: string, observedAt: number) {
  await expect(read(address)).resolves.toMatchObject({ originClass, observedAt });
}

test("lists one workspace in order and preserves corruption", async ({ tempRoot }) => {
  const workspaceDir = path.join(tempRoot, "workspace");
  const seed = (dir: string, relativePath: string) =>
    write({ workspaceDir: dir, relativePath }, "", "synthetic note", 1, "untrusted");
  const expectedPaths = ["memory/first.md", "MEMORY.md", "memory/late.md"];
  for (const relativePath of [...expectedPaths.toReversed(), "memory/expired.md"]) {
    await seed(workspaceDir, relativePath);
  }
  await seed(path.join(tempRoot, "other"), "memory/other.md");
  // Raw fault injection models cold storage, outside the resident owner's lifetime.
  await closeOpenClawStateDatabaseAsync();
  let { db } = openOpenClawStateDatabase();
  const update = (assignment: string, condition = "") =>
    // sqlite-allow-raw -- Seed ordering, expiry, and corruption at the storage boundary.
    db
      .prepare(`UPDATE plugin_state_entries SET ${assignment}
      WHERE plugin_id = ? AND namespace = ? ${condition}`)
      .run("core:memory-artifact-provenance", "workspace-files");
  update(`
         created_at = CASE json_extract(value_json, '$.relativePath') WHEN 'memory/late.md' THEN 20 ELSE 10 END,
         expires_at = CASE json_extract(value_json, '$.relativePath') WHEN 'memory/expired.md' THEN 1 ELSE NULL END
  `);
  const selected = await list({ workspaceDir });
  expect(selected.map((entry) => entry.relativePath)).toEqual(expectedPaths);
  await closeOpenClawStateDatabaseAsync();
  ({ db } = openOpenClawStateDatabase());
  update(
    "value_json = '{malformed'",
    "AND (expires_at = 1 OR json_extract(value_json, '$.relativePath') = 'memory/other.md')",
  );
  await expect(list({ workspaceDir })).resolves.toEqual(selected);
  await closeOpenClawStateDatabaseAsync();
  ({ db } = openOpenClawStateDatabase());
  update("value_json = '{malformed'", "AND json_valid(value_json)");
  await expect(list({ workspaceDir })).rejects.toMatchObject({ code: "PLUGIN_STATE_CORRUPT" });
});

test.for(["write", "restore", "remove", "clear"] as const)(
  "awaits %s persistence and propagates rejection",
  async (operation, { address }) => {
    const first = operation === "write" ? undefined : await write(address, "", "first", 1);
    const rollback = operation === "restore" ? await write(address, "first", "second", 2) : first;
    const error = new Error("synthetic persistence rejection");
    beforeNextPersist(async () => {
      throw error;
    });
    const pending =
      operation === "write"
        ? write(address, "", "first", 1)
        : operation === "clear"
          ? clear({ ...address, contentBefore: "first" })
          : expectDefined(rollback, "provenance rollback")();
    await expect(pending).rejects.toBe(error);
  },
);

test("uses the same workspace identity through symlink aliases", async ({ tempRoot, address }) => {
  const { workspaceDir, relativePath } = address;
  const workspaceAlias = path.join(tempRoot, "workspace-alias");
  await symlink(workspaceDir, workspaceAlias, process.platform === "win32" ? "junction" : "dir");
  await write({ workspaceDir: workspaceAlias, relativePath }, "", "restricted", 1, "untrusted");
  await expectOrigin({ workspaceDir, relativePath }, "untrusted", 1);
  await expect(list({ workspaceDir })).resolves.toMatchObject([{ relativePath }]);
});

test.for(["agent", "untrusted"] as const)(
  "preserves %s origin through later writes, stale rollback, and reload",
  async (origin, { address }) => {
    const rollback = expectDefined(await write(address, "", "first", 1, origin), "rollback");
    await write(address, "first", "second", 2);
    await rollback();
    resetPluginStateStoreForTests();
    await expectOrigin(address, origin, 2);
  },
);

test.for(["write", "rollback", "clear"] as const)(
  "preserves concurrent daily provenance when %s conflicts",
  async (operation, { tempRoot }) => {
    // Daily records stay sticky; a curated record would follow the file bytes instead.
    const address = { workspaceDir: tempRoot, relativePath: "memory/2026-08-20.md" };
    const firstRollback = expectDefined(await write(address, "", "first", 1), "first rollback");
    beforeNextPersist(async () => {
      await write(address, "first", "concurrent", 3, "untrusted");
    });
    if (operation === "write") {
      const rollback = expectDefined(await write(address, "first", "second", 2), "rollback");
      await expectOrigin(address, "untrusted", 2);
      await rollback();
    } else if (operation === "rollback") {
      await firstRollback();
    } else {
      await clear({ ...address, contentBefore: "first" });
    }
    await expectOrigin(address, "untrusted", 3);
  },
);

test.for(["local", "remote document", "remote memory maintenance"] as const)(
  "applies a curated record only to the %s bytes it hashed",
  async (storage, { tempRoot, address }) => {
    const daily = { ...address, relativePath: "memory/2026-08-20.md" };
    const remote = storage !== "local";
    const storageDir = remote ? path.join(tempRoot, "remote") : tempRoot;
    await mkdir(path.join(storageDir, "memory"), { recursive: true });
    // Memory maintenance reads whole files; the capped document bridge refuses large ones.
    const memoryFiles =
      storage === "remote memory maintenance"
        ? createWorkspaceMemoryFileClient({
            workspaceDir: tempRoot,
            remoteWorkspaceDir: "/remote",
            signal: new AbortController().signal,
            request: async (request) => {
              const { method, args } = JSON.parse(request) as { method: string; args: string[] };
              expect(method).toBe("readFile");
              const bytes = await readFile(
                path.join(storageDir, path.posix.relative("/remote", args[0]!)),
              );
              return JSON.stringify({ result: bytes.toString("base64") });
            },
            subscribe: async () => {},
          })
        : undefined;
    const release = remote
      ? registerAgentWorkspaceAccess(tempRoot, {
          bridge: {
            readFile: async ({ filePath }) => {
              if (memoryFiles) {
                throw new Error("Workspace document exceeds its read bound");
              }
              return await readFile(path.join(storageDir, filePath));
            },
            writeFile: async () => {},
            stat: async () => null,
          },
          ...(memoryFiles ? { memoryFiles } : {}),
        })
      : undefined;
    try {
      if (remote) {
        await writeFile(path.join(tempRoot, "MEMORY.md"), "local decoy");
      }
      // A missing file is unreadable and keeps its record.
      await write(address, "", "tainted", 1, "untrusted");
      await expectOrigin(address, "untrusted", 1);
      await writeFile(path.join(storageDir, "MEMORY.md"), "tainted");
      // An automatic rewrite carries the class of the bytes the owner reads, not a caller's claim.
      await rewrite({ ...address, contentAfter: "tainted, kept", observedAt: 2 });
      await writeFile(path.join(storageDir, "MEMORY.md"), "tainted, kept");
      await expectOrigin(address, "untrusted", 2);
      await expect(
        rewrite({ ...daily, contentAfter: "daily rewrite", observedAt: 2 }),
      ).resolves.toBeUndefined();

      await writeFile(path.join(storageDir, "MEMORY.md"), "reviewed");
      await expect(read(address)).resolves.toBeUndefined();
      await write(address, "reviewed", "reviewed, extended", 3);
      await writeFile(path.join(storageDir, "MEMORY.md"), "reviewed, extended");
      await expectOrigin(address, "agent", 3);
      await rewrite({ ...address, contentAfter: "reviewed, promoted", observedAt: 4 });
      await writeFile(path.join(storageDir, "MEMORY.md"), "reviewed, promoted");
      await expectOrigin(address, "agent", 4);

      await write(daily, "", "flushed", 4, "untrusted");
      await writeFile(path.join(storageDir, daily.relativePath), "flushed, edited");
      await write(daily, "flushed, edited", "flushed, edited twice", 5);
      await expectOrigin(daily, "untrusted", 5);
    } finally {
      release?.();
    }
  },
);

test("clears only matching deleted content", async ({ tempRoot }) => {
  const address = { workspaceDir: tempRoot, relativePath: "users/person/USER.md" };
  await write(address, "", "current", 1);
  await clear({ ...address, contentBefore: "stale" });
  await expect(read(address)).resolves.toBeDefined();
  await clear({ ...address, contentBefore: "current" });
  await expect(read(address)).resolves.toBeUndefined();
});

it("accepts only host-owned memory artifact paths", () => {
  for (const valid of ["memory/2026-08-20.md", "MEMORY.md", "USER.md", "users/person/USER.md"]) {
    expect(normalizePath(valid)).toBe(valid);
  }
  for (const invalid of [
    "users/../USER.md",
    "users/person/nested/USER.md",
    "users/person/notes.md",
    "memory/dreaming/state.md",
    "../memory/escape.md",
  ]) {
    expect(normalizePath(invalid)).toBeUndefined();
  }
});
