import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withTempWorkspace } from "@openclaw/fs-safe/temp";
import {
  readGitHubRepositoryPublicationBlob,
  readGitHubRepositoryPublicationMetadata,
} from "../gateway/github-repository-publication-snapshot.js";
import { boundedWorkerError } from "../gateway/worker-environments/worker-error.js";
import { importWorkerWorkspaceHistory } from "../gateway/worker-environments/workspace-result-history.js";
import type { WorkerWorkspaceGitHistory } from "../gateway/worker-environments/workspace-result-inventory.js";
import { appendGitConfig, gitMaintenanceEnvironment } from "../infra/git-maintenance-env.js";
import { runCommandBuffered } from "../process/exec.js";
import {
  NODE_WORKSPACE_EMPTY_MANIFEST,
  NODE_WORKSPACE_EMPTY_MANIFEST_REF,
  NodeWorkerPublicationConflictError,
} from "../worker/node-workspace-transfer-protocol.js";
import type { WorkspaceTransferOperation } from "./node-worker-transfer-client.js";

/** The editing checkout supplies objects only; all indexes, fetches and merges stay private. */
export async function mergeNodeRepositoryPublication(params: {
  workspaceDir: string;
  inputRoot: string;
  inputDigest: string;
  outputRoot: string;
  sourceUrl: string;
  targetUrl: string;
  targetCommit: string;
  token: string;
  gitHistory?: WorkerWorkspaceGitHistory;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}): Promise<void> {
  const { snapshot } = await readGitHubRepositoryPublicationMetadata(
    params.inputRoot,
    params.inputDigest,
  );
  await withTempWorkspace(
    { rootDir: path.dirname(params.outputRoot), prefix: "publication-git-" },
    async ({ dir }) => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(env)) {
        if (/^(GIT_|GH_TOKEN$|GITHUB_TOKEN$)/iu.test(key)) {
          delete env[key];
        }
      }
      Object.assign(env, {
        HOME: dir,
        XDG_CONFIG_HOME: dir,
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_SYSTEM: os.devNull,
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_AUTHOR_NAME: "OpenClaw",
        GIT_AUTHOR_EMAIL: "publication@openclaw.invalid",
        GIT_COMMITTER_NAME: "OpenClaw",
        GIT_COMMITTER_EMAIL: "publication@openclaw.invalid",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
        ...appendGitConfig(gitMaintenanceEnvironment(), [
          ["core.hooksPath", os.devNull],
          ["credential.helper", ""],
          ["http.followRedirects", "false"],
          ...[...new Set([params.sourceUrl, params.targetUrl])].map((url): [string, string] => [
            `http.${url}.extraheader`,
            `Authorization: Basic ${Buffer.from(`x-access-token:${params.token}`).toString("base64")}`,
          ]),
        ]),
      });
      const run = async (args: string[], input?: string | Buffer, cwd = dir) => {
        params.signal?.throwIfAborted();
        params.assertCurrent?.();
        return await runCommandBuffered(["git", ...args], {
          cwd,
          baseEnv: env,
          input,
          signal: params.signal,
          timeoutMs: 120_000,
          maxOutputBytes: 64 * 1024 * 1024,
        });
      };
      const git = async (
        args: string[],
        input?: string | Buffer,
        cwd = dir,
        fetchRole?: "source-base" | "target-base",
      ) => {
        const result = await run(args, input, cwd);
        if (result.code !== 0 || result.error) {
          // Git commands can emit source content. Only fetch stderr is a diagnostic.
          let detail = "";
          if (args[0] === "fetch") {
            const basic = Buffer.from(`x-access-token:${params.token}`).toString("base64");
            const secrets = [
              params.token,
              `x-access-token:${params.token}`,
              basic,
              `Basic ${basic}`,
              `Authorization: Basic ${basic}`,
              params.sourceUrl,
              params.targetUrl,
            ]
              .flatMap((value) => [
                value,
                encodeURIComponent(value),
                new URLSearchParams({ v: value }).toString().slice(2),
              ])
              .toSorted((a, b) => b.length - a.length);
            let stderr = result.stderr
              .toString("utf8")
              .replace(/%[\da-f]{2}/giu, (escape) => escape.toUpperCase());
            for (const value of secrets) {
              if (value) {
                stderr = stderr.replaceAll(
                  value.replace(/%[\da-f]{2}/giu, (escape) => escape.toUpperCase()),
                  "[redacted]",
                );
              }
            }
            stderr = stderr.replace(/\bhttps?(?::\/\/|%3a%2f%2f)[^\s"'<>]+/giu, "[redacted URL]");
            detail = ` fetch=${fetchRole}; ${boundedWorkerError(stderr, 4000)}`;
          }
          throw new Error(
            `Publication integration ${args[0]} failed (${result.termination}; exit ${result.code}).${detail}`,
          );
        }
        return result.stdout;
      };
      const text = async (args: string[], input?: string | Buffer) =>
        (await git(args, input)).toString("utf8").trim();
      await git(["init", "--bare", "--quiet", "--template=", "--object-format=sha1"]);
      const objects = (
        await git(
          ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
          undefined,
          params.workspaceDir,
        )
      )
        .toString("utf8")
        .trim();
      await fs.writeFile(path.join(dir, "objects", "info", "alternates"), `${objects}\n`);
      for (const [role, url, commit] of [
        ["source-base", params.sourceUrl, snapshot.baseCommit],
        ["target-base", params.targetUrl, params.targetCommit],
      ] as const) {
        await git(
          [
            "fetch",
            "--no-tags",
            "--no-auto-maintenance",
            "--no-write-fetch-head",
            "--no-recurse-submodules",
            "--",
            url,
            commit,
          ],
          undefined,
          dir,
          role,
        );
      }
      if ((await text(["rev-parse", `${snapshot.baseCommit}^{tree}`])) !== snapshot.baseTree) {
        throw new Error("Publication integration source base changed.");
      }
      let retainedHead: string | undefined;
      const history = params.gitHistory;
      if (history) {
        if (
          history.baseCommit !== snapshot.baseCommit ||
          !history.descendsFromBase ||
          history.unavailableReason
        ) {
          throw new Error("Publication retained history does not match the accepted base.");
        }
        await importWorkerWorkspaceHistory({
          root: dir,
          gitHistory: history,
          gitPackPath: path.join(params.inputRoot, "history.pack"),
          baseEnv: env,
          assertCurrent: () => params.signal?.throwIfAborted(),
        });
        // Uncommitted changes cannot borrow a different tree's ancestry.
        if (
          (await text(["rev-parse", `${history.headCommit}^{tree}`])) === snapshot.workspaceTree
        ) {
          retainedHead = history.headCommit;
        }
      }
      for (const sha of new Set(
        snapshot.entries.flatMap((entry) =>
          entry.sha && entry.mode !== "160000" ? [entry.sha] : [],
        ),
      )) {
        const bytes = await readGitHubRepositoryPublicationBlob(params.inputRoot, sha);
        await git(["hash-object", "-w", "--stdin"], bytes);
      }
      env.GIT_INDEX_FILE = path.join(dir, "publication-index");
      await git(["read-tree", snapshot.baseTree]);
      await git(
        ["update-index", "-z", "--index-info"],
        snapshot.entries
          .map(
            (entry) =>
              `${entry.sha === null ? "0" : entry.mode} ${entry.sha ?? "0".repeat(40)}\t${entry.path}\0`,
          )
          .join(""),
      );
      if ((await text(["write-tree"])) !== snapshot.workspaceTree) {
        throw new Error("Publication integration input tree changed.");
      }
      const accepted =
        retainedHead ??
        (await text(
          ["commit-tree", snapshot.workspaceTree, "-p", snapshot.baseCommit],
          "Accepted publication checkpoint\n",
        ));
      const merge = await run(["merge-tree", "--write-tree", accepted, params.targetCommit]);
      if (merge.code === 1) {
        throw new NodeWorkerPublicationConflictError();
      }
      const workspaceTree = merge.stdout.toString("utf8").trim();
      if (merge.code !== 0 || !/^[a-f0-9]{40}$/u.test(workspaceTree)) {
        throw new Error("Publication integration could not produce a merged tree.");
      }
      const baseTree = await text(["rev-parse", `${params.targetCommit}^{tree}`]);
      const raw = await git([
        "diff-tree",
        "--no-commit-id",
        "--raw",
        "-r",
        "-z",
        "--no-renames",
        baseTree,
        workspaceTree,
      ]);
      const decoded = raw.toString("utf8");
      if (!Buffer.from(decoded).equals(raw)) {
        throw new Error("Publication integration paths must be UTF-8.");
      }
      const fields = decoded.split("\0");
      const entries = [];
      await fs.mkdir(path.join(params.outputRoot, "blobs"), { recursive: true });
      for (let i = 0; i < fields.length - 1; i += 2) {
        const [oldMode, newMode, , newSha, status] = fields[i]!.slice(1).split(" ");
        const entry = {
          path: fields[i + 1]!,
          mode: status === "D" ? oldMode : newMode,
          sha: status === "D" ? null : newSha,
        };
        entries.push(entry);
        if (entry.sha && entry.mode !== "160000") {
          await fs.writeFile(
            path.join(params.outputRoot, "blobs", entry.sha),
            await git(["cat-file", "blob", entry.sha]),
          );
        }
      }
      await fs.writeFile(
        path.join(params.outputRoot, "snapshot.json"),
        JSON.stringify({
          version: 1,
          baseCommit: params.targetCommit,
          baseTree,
          workspaceTree,
          entries,
        }),
      );
    },
  );
}

export async function transferNodeRepositoryPublication(
  params: WorkspaceTransferOperation<"publication">,
  operations: {
    download: (input: WorkspaceTransferOperation<"download">) => Promise<string>;
    upload: (input: WorkspaceTransferOperation<"upload">) => Promise<string>;
  },
): Promise<string> {
  const transfer = params.transfer;
  return await withTempWorkspace(
    {
      rootDir: path.join(params.manifestHome, ".openclaw-worker", "publication"),
      prefix: "publication-merge-",
    },
    async ({ dir }) => {
      const inputRoot = path.join(dir, "input");
      const outputRoot = path.join(dir, "output");
      await operations.download({
        ...params,
        workspaceDir: inputRoot,
        prepared: undefined,
        hashMemo: undefined,
        request: { ...params.request, token: transfer.inputToken },
        setStage: params.setStage,
        transfer: {
          direction: "download",
          token: transfer.inputToken,
          manifestRef: transfer.inputManifestRef,
        },
      });
      await mergeNodeRepositoryPublication({
        workspaceDir: params.workspaceDir,
        inputRoot,
        outputRoot,
        inputDigest: transfer.inputDigest,
        sourceUrl: transfer.sourceUrl,
        targetUrl: transfer.targetUrl,
        targetCommit: transfer.targetCommit,
        token: transfer.gitToken,
        gitHistory: transfer.checkpointGitHistory,
        signal: params.signal,
        assertCurrent: params.assertCurrent,
      });
      const manifests = path.join(params.manifestHome, ".openclaw-worker", "manifests");
      await fs.mkdir(manifests, { recursive: true });
      await fs.writeFile(
        path.join(manifests, `${NODE_WORKSPACE_EMPTY_MANIFEST_REF.slice(7)}.json`),
        NODE_WORKSPACE_EMPTY_MANIFEST,
      );
      return await operations.upload({
        ...params,
        workspaceDir: outputRoot,
        prepared: undefined,
        hashMemo: undefined,
        request: params.request,
        setStage: params.setStage,
        transfer: {
          direction: "upload",
          token: transfer.token,
          baseManifestRef: NODE_WORKSPACE_EMPTY_MANIFEST_REF,
          referenceManifestRef: NODE_WORKSPACE_EMPTY_MANIFEST_REF,
        },
      });
    },
  );
}
