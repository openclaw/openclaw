import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { requireGit, runGit } from "../../agents/worktrees/git.js";
import {
  AUTHORIZATION,
  TOKEN,
  URL,
  assertNoCredentialFiles,
  fixture,
} from "./repository-git-pack.test-support.js";
import { MAX_WORKSPACE_INVENTORY_TOTAL_BYTES } from "./workspace-inventory-limits.js";

describe("private repository preparation", () => {
  it("fetches only the pinned tree under its selected identity without inherited credentials or hooks", async () => {
    const f = await fixture();
    const poisonHome = path.join(f.root, "unrelated-home");
    const trace = path.join(f.root, "trace");
    await fs.mkdir(poisonHome);
    await fs.writeFile(path.join(poisonHome, ".netrc"), "default login unrelated password wrong\n");
    await fs.writeFile(
      path.join(poisonHome, ".gitconfig"),
      "[http]\nextraHeader = Authorization: Basic unrelated\n[trace2]\neventTarget = " +
        trace +
        "\n",
    );
    for (const [name, value] of Object.entries({
      HOME: poisonHome,
      GIT_CONFIG_PARAMETERS: "'http.extraHeader=Authorization: Basic unrelated'",
      GIT_DIR: "/missing/git-dir",
      GIT_OBJECT_DIRECTORY: "/missing/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/missing/alternates",
      GIT_EXEC_PATH: "/missing/git-exec",
      GIT_TRACE: trace,
      GIT_TRACE_CURL: trace,
      GIT_TRACE2_EVENT: trace,
      GIT_ASKPASS: "/missing/askpass",
      GITHUB_TOKEN: "unrelated-account",
    })) {
      vi.stubEnv(name, value);
    }
    const pack = await f.preparePack();
    vi.unstubAllEnvs();
    expect(f.requests.length).toBeGreaterThan(0);
    expect(f.requests.every((authorization) => authorization === AUTHORIZATION)).toBe(true);
    expect(JSON.stringify(f.fetches)).not.toContain(TOKEN);
    expect(JSON.stringify(f.fetches)).not.toContain(AUTHORIZATION.slice(6));
    expect(await fs.stat(trace).catch(() => undefined)).toBeUndefined();
    await assertNoCredentialFiles(f.scratch);
    const unpacked = path.join(f.root, "unpacked");
    await fs.mkdir(unpacked);
    await requireGit(unpacked, ["init", "--quiet"]);
    await requireGit(unpacked, ["index-pack", "--stdin"], { input: await fs.readFile(pack) });
    expect(await requireGit(unpacked, ["show", `${f.baseCommit}:input.txt`])).toBe(
      "pinned private content",
    );
    for (const absent of [f.ancestor, f.oldBlob, f.later]) {
      expect((await runGit(unpacked, ["cat-file", "-e", absent])).code).not.toBe(0);
    }
    expect(
      await fs.readdir(path.join(f.scratch, "repository.git", "hooks")).catch(() => []),
    ).toEqual([]);
    expect(
      await fs.stat(path.join(f.scratch, "repository.git", "input.txt")).catch(() => undefined),
    ).toBeUndefined();
  });

  it("discards failed authenticated Git diagnostics including encoded credentials", async () => {
    const f = await fixture();
    f.mode.reject = true;
    const error = await f.preparePack().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("check access");
    expect(String(error)).not.toContain(TOKEN);
    expect(String(error)).not.toContain(AUTHORIZATION.slice(6));
    expect(f.failedDiagnostics.join("\n")).toContain(TOKEN);
    expect(f.failedDiagnostics.join("\n")).toContain(AUTHORIZATION.slice(6));
    await assertNoCredentialFiles(f.scratch);
  });

  it("settles a canceled real fetch before returning its original reason", async () => {
    const f = await fixture();
    f.mode.stall = true;
    const controller = new AbortController();
    const reason = new Error("preparation owner replaced");
    const result = f.preparePack(controller.signal).catch((error: unknown) => error);
    await Promise.race([
      f.received,
      result.then((outcome) => {
        throw outcome instanceof Error
          ? outcome
          : new Error("Fetch settled before contacting the synthetic endpoint");
      }),
    ]);
    controller.abort(reason);
    expect(await result).toBe(reason);
    expect(f.fetches).toHaveLength(1);
    expect(f.fetches[0]?.settled).toBe(true);
    await f.disconnected;
    expect(
      await fs.stat(path.join(f.scratch, `${f.baseCommit}.pack`)).catch(() => undefined),
    ).toBeUndefined();
    await assertNoCredentialFiles(f.scratch);
  });

  it("imports, builds and reuses a private prepared workspace without remote credentials", async () => {
    const f = await fixture();
    const first = f.operation();
    const second = f.operation();
    try {
      const result = await first.project.prepare(f.transport);
      const prepared = result.preparedWorkspace!;
      expect(result.captureRequired).toBe(true);
      expect(await fs.readFile(path.join(prepared.workspaceDir, "build/result"), "utf8")).toBe(
        "pinned private content\n",
      );
      expect(await requireGit(prepared.workspaceDir, ["remote", "get-url", "origin"])).toBe(URL);
      expect((await second.project.prepare(f.transport)).preparedWorkspace).toEqual(prepared);
      expect(await fs.readFile(path.join(prepared.homeDir, "count"), "utf8")).toBe("setup\n");
      expect(f.fetches).toHaveLength(1);
      expect(f.scripts.join("\n")).not.toContain(TOKEN);
      expect(f.scripts.join("\n")).not.toContain(AUTHORIZATION.slice(6));
      await assertNoCredentialFiles(f.home);
    } finally {
      first.close();
      second.close();
    }
  });

  it("joins late pack publication before cleanup and stops before seed installation or setup", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const reason = new Error("canceled after upload publication");
    const operation = f.operation(controller.signal);
    let localPack: string | undefined;
    let remotePack: string | undefined;
    let publicationJoined = false;
    let settled = false;
    const published = createDeferred();
    const releaseUpload = createDeferred();
    try {
      const result = operation.project
        .prepare({
          ...f.transport,
          upload: async (from, to) => {
            localPack = from;
            remotePack = to;
            await fs.copyFile(from, to);
            controller.abort(reason);
            published.resolve();
            await releaseUpload.promise;
            expect(await fs.stat(from)).toBeDefined();
            publicationJoined = true;
          },
        })
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      await Promise.race([
        published.promise,
        result.then((outcome) => {
          throw outcome instanceof Error
            ? outcome
            : new Error("Preparation settled before publishing its pack");
        }),
      ]);
      expect(await fs.stat(localPack!)).toBeDefined();
      expect(settled).toBe(false);
      releaseUpload.resolve();
      expect(await result).toBe(reason);
      expect(publicationJoined).toBe(true);
      expect(await fs.stat(path.dirname(localPack!)).catch(() => undefined)).toBeUndefined();
      expect(await fs.stat(remotePack!)).toBeDefined();
      expect(f.scripts).toHaveLength(1);
      expect(operation.getPreparedWorkspace()).toBeUndefined();
      expect(
        await fs.stat(path.join(f.home, ".openclaw-worker/prepared")).catch(() => undefined),
      ).toBeUndefined();
      await assertNoCredentialFiles(f.home);
    } finally {
      releaseUpload.resolve();
      operation.close();
    }
  });

  it("removes local scratch after rejecting an oversized pack before upload", async () => {
    const f = await fixture();
    let temporaryRoot: string | undefined;
    const operation = f.operation(undefined, async (input) => {
      temporaryRoot = input.temporaryRoot;
      const pack = path.join(temporaryRoot, "oversized.pack");
      const file = await fs.open(pack, "wx", 0o600);
      try {
        // A sparse file reaches the real pre-upload stat boundary without a 4 GiB allocation.
        await file.truncate(MAX_WORKSPACE_INVENTORY_TOTAL_BYTES + 1);
      } finally {
        await file.close();
      }
      return pack;
    });
    const upload = vi.fn(f.transport.upload);
    try {
      await expect(operation.project.prepare({ ...f.transport, upload })).rejects.toThrow(
        "Project Git pack exceeds the workspace byte limit",
      );
      expect(temporaryRoot).toBeDefined();
      expect(await fs.stat(temporaryRoot!).catch(() => undefined)).toBeUndefined();
      expect(upload).not.toHaveBeenCalled();
      expect(f.scripts).toHaveLength(1);
      expect(operation.getPreparedWorkspace()).toBeUndefined();
    } finally {
      operation.close();
    }
  });
});
