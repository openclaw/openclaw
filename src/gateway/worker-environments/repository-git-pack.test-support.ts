import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterEach, expect, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import * as gitExec from "../../infra/git-exec.js";
import { createWorkerProjectPreparation } from "./project-preparation.js";
import { prepareRepositoryWorkerGitPack } from "./repository-git-pack.js";
import type { RepositoryWorkerProjectSnapshot } from "./repository-project-source.schema.js";

type RepositoryPackProducer = NonNullable<
  Parameters<typeof createWorkerProjectPreparation>[0]["prepareRepositoryGitPack"]
>;

export const URL = "https://github.com/openclaw/private-preparation-fixture.git";
export const TOKEN = "synthetic-fixture-token+/";
export const AUTHORIZATION = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;
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

export async function assertNoCredentialFiles(root: string) {
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

export async function fixture(fixtureOptions: { setupRecipe?: boolean } = {}) {
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
  if (fixtureOptions.setupRecipe !== false) {
    await fs.mkdir(path.join(source, ".openclaw"));
    await fs.writeFile(
      path.join(source, ".openclaw/worktree-setup.sh"),
      '#!/bin/sh\nset -eu\nmkdir -p build\ncat input.txt > build/result\nprintf "setup\\n" >> "$HOME/count"\n',
      { mode: 0o755 },
    );
  }
  await requireGit(source, ["add", "."]);
  await requireGit(source, ["commit", "--quiet", "-m", "pinned"]);
  const baseCommit = await requireGit(source, ["rev-parse", "HEAD"]);
  const setupRecipe =
    fixtureOptions.setupRecipe === false
      ? undefined
      : await requireGit(source, ["rev-parse", "HEAD:.openclaw/worktree-setup.sh"]);
  const tree = await requireGit(source, ["rev-parse", "HEAD^{tree}"]);
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
  const beforeFetch = { run: async () => {} };
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
      await beforeFetch.run();
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
    remote,
    endpoint,
    scratch,
    home,
    baseCommit,
    tree,
    project,
    ancestor,
    oldBlob,
    later,
    requests,
    mode,
    received: received.promise,
    disconnected: disconnected.promise,
    fetches,
    beforeFetch,
    failedDiagnostics,
    scripts,
    preparePack,
    operation,
    transport,
  };
}
