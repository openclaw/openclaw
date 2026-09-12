import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit, runGit } from "../../agents/worktrees/git.js";
import * as gitExec from "../../infra/git-exec.js";
import { createWorkerProjectPreparation } from "./project-preparation.js";
import { prepareRepositoryWorkerGitPack } from "./repository-git-pack.js";
import type { RepositoryWorkerProjectSnapshot } from "./repository-project-source.js";
import { MAX_WORKSPACE_INVENTORY_TOTAL_BYTES } from "./workspace-inventory-limits.js";

type RepositoryPackProducer = NonNullable<
  Parameters<typeof createWorkerProjectPreparation>[0]["prepareRepositoryGitPack"]
>;

const URL = "https://github.com/openclaw/private-preparation-fixture.git";
const TOKEN = "synthetic-fixture-token+/";
const AUTHORIZATION = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;
const executeGitCommand = gitExec.executeGitCommand;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function assertNoCredentialFiles(root: string) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await assertNoCredentialFiles(file);
    } else if (entry.isFile()) {
      const contents = await fs.readFile(file);
      expect(contents.includes(Buffer.from(TOKEN)), file).toBe(false);
      expect(contents.includes(Buffer.from(AUTHORIZATION.slice(6))), file).toBe(false);
    }
  }
}

async function fixture() {
  const root = await fs.realpath(tempDirs.make("repository-git-pack-"));
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  const home = path.join(root, "worker-home");
  const scratch = path.join(root, "scratch");
  await Promise.all([source, home, scratch].map((directory) => fs.mkdir(directory)));
  await requireGit(source, ["init", "--quiet"]);
  await requireGit(source, ["config", "user.name", "Project Test"]);
  await requireGit(source, ["config", "user.email", "project@example.invalid"]);
  await requireGit(source, ["config", "commit.gpgsign", "false"]);
  await fs.writeFile(path.join(source, "input.txt"), "old private content\n");
  await requireGit(source, ["add", "."]);
  await requireGit(source, ["commit", "--quiet", "-m", "ancestor"]);
  const ancestor = await requireGit(source, ["rev-parse", "HEAD"]);
  const oldBlob = await requireGit(source, ["rev-parse", "HEAD:input.txt"]);
  await fs.writeFile(path.join(source, "input.txt"), "pinned private content\n");
  await fs.mkdir(path.join(source, ".openclaw"));
  await fs.writeFile(
    path.join(source, ".openclaw/worktree-setup.sh"),
    '#!/bin/sh\nset -eu\nmkdir -p build\ncat input.txt > build/result\nprintf "setup\\n" >> "$HOME/count"\n',
    { mode: 0o755 },
  );
  await requireGit(source, ["add", "."]);
  await requireGit(source, ["commit", "--quiet", "-m", "pinned"]);
  const baseCommit = await requireGit(source, ["rev-parse", "HEAD"]);
  const setupRecipe = await requireGit(source, ["rev-parse", "HEAD:.openclaw/worktree-setup.sh"]);
  await fs.writeFile(path.join(source, "input.txt"), "later private content\n");
  await requireGit(source, ["commit", "--quiet", "-am", "later"]);
  const later = await requireGit(source, ["rev-parse", "HEAD"]);
  await requireGit(root, ["clone", "--quiet", "--bare", "--no-local", source, remote]);

  const received = createDeferred();
  const disconnected = createDeferred();
  const mode = { reject: false, stall: false };
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request.headers.authorization ?? "");
    received.resolve();
    response.once("close", disconnected.resolve);
    if (mode.stall) {
      return;
    }
    if (mode.reject || request.headers.authorization !== AUTHORIZATION) {
      response.writeHead(403, { "Content-Type": "text/plain" });
      response.end(`Rejected ${TOKEN} ${AUTHORIZATION}`);
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const [pathname, query = ""] = (request.url ?? "").split("?");
      try {
        const output = execFileSync("git", ["http-backend"], {
          input: Buffer.concat(chunks),
          timeout: 10_000,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: gitExec.gitNullConfigPath(),
            GIT_PROJECT_ROOT: root,
            GIT_HTTP_EXPORT_ALL: "1",
            PATH_INFO: pathname,
            REQUEST_METHOD: request.method,
            QUERY_STRING: query,
            CONTENT_TYPE: request.headers["content-type"],
            HTTP_GIT_PROTOCOL: request.headers["git-protocol"]?.toString(),
          },
        });
        const split = output.indexOf("\r\n\r\n");
        if (split < 0) {
          throw new Error("Synthetic Git backend omitted CGI headers");
        }
        for (const header of output.subarray(0, split).toString().split("\r\n")) {
          const colon = header.indexOf(":");
          const name = header.slice(0, colon);
          const value = header.slice(colon + 1).trim();
          if (name.toLowerCase() === "status") {
            response.statusCode = Number(value.split(" ")[0]);
          } else {
            response.setHeader(name, value);
          }
        }
        response.end(output.subarray(split + 4));
      } catch {
        response.writeHead(500);
        response.end("Synthetic Git backend failed");
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Synthetic Git endpoint has no TCP address");
  }
  const endpoint = `http://127.0.0.1:${address.port}/remote.git`;
  const fetches: { argv: string[]; settled: boolean }[] = [];
  const failedDiagnostics: string[] = [];
  // Only translate the admitted network boundary. Git transport, authentication,
  // object selection, cancellation, and the emitted pack all execute for real.
  vi.spyOn(gitExec, "executeGitCommand").mockImplementation(async (cwd, args, options) => {
    if (!args.includes(URL)) {
      return executeGitCommand(cwd, args, options);
    }
    const fetch = { argv: [...args], settled: false };
    fetches.push(fetch);
    try {
      const result = await executeGitCommand(
        cwd,
        args.map((arg) => (arg === URL ? endpoint : arg)),
        {
          ...options,
          baseEnv: { ...options?.baseEnv, GIT_ALLOW_PROTOCOL: "http" },
          env: { ...options?.env, GIT_CONFIG_KEY_2: `http.${endpoint}.extraHeader` },
        },
      );
      if (result.code !== 0) {
        failedDiagnostics.push(result.stderr);
      }
      return result;
    } finally {
      fetch.settled = true;
    }
  });
  const project: RepositoryWorkerProjectSnapshot = {
    key: "a".repeat(64),
    baseCommit,
    source: {
      kind: "repository",
      url: URL,
      repositoryId: "R_private_fixture",
      owner: {
        agent: { agentId: "main", provenance: null },
        identity: { source: "system-detected", accountId: 123 },
      },
    },
  };
  const preparePack = (signal = new AbortController().signal, temporaryRoot = scratch) =>
    prepareRepositoryWorkerGitPack({
      url: URL,
      baseCommit,
      token: TOKEN,
      temporaryRoot,
      signal,
      assertCurrent: () => {},
    });
  const operation = (
    ownerSignal?: AbortSignal,
    prepareRepositoryGitPack: RepositoryPackProducer = ({ temporaryRoot, signal }) =>
      preparePack(signal, temporaryRoot),
  ) =>
    createWorkerProjectPreparation({
      project,
      namespace: "gateway",
      preparation: {
        key: "b".repeat(64),
        cacheKey: "c".repeat(64),
        purpose: "session",
        demandAtMs: 1_000,
        setupRecipe,
      },
      signal: ownerSignal,
      setupAuthorized: true,
      requireCurrent: () => {},
      revalidateRepositorySource: async () => {},
      prepareRepositoryGitPack,
    });
  const scripts: string[] = [];
  const runScript = async (script: string) => {
    scripts.push(script);
    return execFileSync("sh", ["-c", script], {
      encoding: "utf8",
      timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home },
    });
  };
  const transport = {
    runScript,
    runScriptWithBudget: async (createScript: (timeoutMs: number) => string) =>
      runScript(createScript(30_000)),
    upload: async (from: string, to: string) => fs.copyFile(from, to),
  };
  return {
    root,
    source,
    scratch,
    home,
    baseCommit,
    ancestor,
    oldBlob,
    later,
    requests,
    mode,
    received: received.promise,
    disconnected: disconnected.promise,
    fetches,
    failedDiagnostics,
    scripts,
    preparePack,
    operation,
    transport,
  };
}

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
