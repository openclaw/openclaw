import { createHash } from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SpawnResult } from "../../process/exec.js";
import type {
  PreparedRepositoryWorkspace,
  WorkerWorkspaceCommand,
  WorkerWorkspaceSyncResult,
} from "./tunnel-contract.js";
import { boundedWorkerError } from "./worker-error.js";
import {
  workerWorkspaceCommandSucceeded as succeeded,
  workspaceSyncError,
} from "./workspace-sync-helpers.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";

const GIT_TIMEOUT_MS = 60_000;
const MANIFEST_REF_PATTERN = /^sha256:[a-f0-9]{64}$/u;
export const WORKER_REPOSITORY_GIT_ARGS = ["-c", "credential.helper=", "-c", "core.askPass="];
const workspaceSyncLog = createSubsystemLogger("gateway/worker-workspace");

export type NodeWorkerRepositoryExec = (
  params: WorkerWorkspaceCommand & { resetWorkspace?: boolean },
) => Promise<SpawnResult & { workspaceDir: string }>;

type RepositoryIdentity = {
  origin: string;
  commit?: string;
  ref?: string;
  branch?: string;
};

const CREDENTIAL_FREE_GIT_JS = String.raw`const { spawnSync } = require("node:child_process");
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(GIT_|GH_TOKEN$|GITHUB_TOKEN$)/i.test(key)) delete env[key];
Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" });
const args = process.argv.slice(1);
// Identity-scoped workspaces can put partial-clone .promisor files at MAX_PATH.
if (process.platform === "win32") args.unshift("-c", "core.longpaths=true");
const result = spawnSync("git", args, { env, stdio: ["ignore", "inherit", "inherit"] });
if (result.error) console.error((result.error.code ? result.error.code + ": " : "") + result.error.message);
process.exitCode = result.status ?? 1;`;

const BIND_PREPARED_REPOSITORY_JS = String.raw`const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { origin, commit, branch, workspaceDir, author, transferred } = JSON.parse(fs.readFileSync(0, "utf8"));
if (fs.realpathSync(process.cwd()) !== fs.realpathSync(workspaceDir)) throw Error("Prepared repository workspace changed");
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(GIT_|GH_TOKEN$|GITHUB_TOKEN$)/i.test(key)) delete env[key];
const nil = process.platform === "win32" ? "NUL" : "/dev/null";
Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: nil, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" });
const git = (args, allowDetached = false) => {
  const result = spawnSync("git", ["-c", "core.hooksPath=" + nil, "-c", "core.fsmonitor=false", ...args], {
    env, encoding: "utf8", timeout: 30000, maxBuffer: 262144,
  });
  if (allowDetached && result.status === 1) return undefined;
  if (result.error || result.status !== 0) throw Error("Prepared repository Git verification failed");
  return result.stdout.trim();
};
if (git(["rev-parse", "--verify", "HEAD^{commit}"]) !== commit) throw Error("Prepared repository differs from its admitted source");
if (transferred) {
  // The snapshot transfer imports objects and files only, with no origin or credential config.
  if (git(["remote"]) !== "" || git(["symbolic-ref", "--quiet", "--short", "HEAD"]) !== "openclaw-worker") throw Error("Transferred repository identity changed");
  git(["remote", "add", "origin", origin]);
  git(["branch", "-m", branch]);
} else if (git(["remote", "get-url", "origin"]) !== origin) throw Error("Prepared repository differs from its admitted source");
git(["check-ref-format", "--branch", branch]);
const current = git(["symbolic-ref", "--quiet", "--short", "HEAD"], true);
if (current !== branch) {
  if (current !== undefined) throw Error("Prepared repository already belongs to another session branch");
  git(["checkout", "-b", branch, commit]);
}
for (const [key, value] of Object.entries(author ?? {})) {
  if (value) git(["config", "--local", "user." + key, value]);
}
`;

export type NodeWorkerRepositoryOutcome =
  | {
      kind: "prepared";
      seeded: boolean;
      result: WorkerWorkspaceSyncResult & { baseCommit: string };
    }
  | {
      kind: "failed";
      reason: "clone-failed" | "checkout-failed" | "manifest-capture-failed" | "manifest-mismatch";
      detail?: string;
    };

function gitFailure(
  reason: "clone-failed" | "checkout-failed",
  stage: string,
  result: SpawnResult,
  invariant?: string,
): NodeWorkerRepositoryOutcome {
  return {
    kind: "failed",
    reason,
    detail: boundedWorkerError(
      `${stage}: ${result.termination} (exit code ${result.code}, signal ${result.signal}): ${invariant ?? (result.stderr.trim() || "no stderr output")}`,
    ),
  };
}

/**
 * Admission owns the validated repository source; the command owner fences
 * every operation to its remote session workspace. This owner never reads a Gateway checkout.
 */
export function createNodeWorkerRepositoryPreparation(
  run: NodeWorkerRepositoryExec,
  authorize?: () => void,
) {
  // Invocation-owned preparation must not lend its authority to retained workspace custody.
  const exec: NodeWorkerRepositoryExec = async (command) => {
    authorize?.();
    const assertCurrent = () => {
      command.assertCurrent?.();
      authorize?.();
    };
    const result = await run({ ...command, ...(authorize ? { assertCurrent } : {}) });
    authorize?.();
    return result;
  };
  let seedStoreFailureLogged = false;
  const git = (args: string[], resetWorkspace?: boolean) =>
    exec({
      argv: ["node", "-e", CREDENTIAL_FREE_GIT_JS, "--", ...WORKER_REPOSITORY_GIT_ARGS, ...args],
      ...(resetWorkspace ? { resetWorkspace: true } : {}),
      timeoutMs: GIT_TIMEOUT_MS,
      transportRetry: "never",
    });
  const capture = async (dir: string, base: string | null, reference?: string) =>
    await exec({
      argv: [
        "node",
        "-e",
        REMOTE_WORKSPACE_MANIFEST_JS,
        dir,
        ...(base ? [base, "eligible"] : ["", "all"]),
        ...(reference ? [reference.slice("sha256:".length)] : []),
      ],
      timeoutMs: GIT_TIMEOUT_MS,
      transportRetry: "idempotent",
    });
  const checkoutAndCapture = async (
    identity: RepositoryIdentity,
    workspaceDir: string,
    expectedManifestRef: string | undefined,
    seeded: boolean,
  ): Promise<NodeWorkerRepositoryOutcome> => {
    // Restore asks for the immutable SHA even when a force push removed its branch ref.
    const fetched = await git([
      "fetch",
      "--no-tags",
      "--",
      "origin",
      identity.commit ?? identity.ref ?? "HEAD",
    ]);
    if (!succeeded(fetched)) {
      return gitFailure("checkout-failed", "git fetch", fetched);
    }
    const resolved = await git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
    const revision = resolved.stdout.trim();
    if (!succeeded(resolved)) {
      return gitFailure("checkout-failed", "git rev-parse", resolved);
    }
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(revision)) {
      return gitFailure("checkout-failed", "git rev-parse", resolved, "invalid commit revision");
    }
    if (identity.commit !== undefined && revision !== identity.commit) {
      return gitFailure("checkout-failed", "git rev-parse", resolved, "requested commit mismatch");
    }
    const checkedOut = await git(["checkout", "--detach", "--force", revision]);
    if (!succeeded(checkedOut)) {
      return gitFailure("checkout-failed", "git checkout --detach", checkedOut);
    }
    if (checkedOut.workspaceDir !== workspaceDir) {
      return gitFailure(
        "checkout-failed",
        "git checkout --detach",
        checkedOut,
        "workspace directory changed during checkout",
      );
    }
    const captured = await capture(checkedOut.workspaceDir, revision);
    const manifestRef = captured.stdout.trim();
    if (!succeeded(captured) || !MANIFEST_REF_PATTERN.test(manifestRef)) {
      return { kind: "failed", reason: "manifest-capture-failed" };
    }
    if (expectedManifestRef !== undefined && manifestRef !== expectedManifestRef) {
      return { kind: "failed", reason: "manifest-mismatch" };
    }
    return {
      kind: "prepared",
      seeded,
      result: {
        mode: "git",
        remoteWorkspaceDir: checkedOut.workspaceDir,
        manifestRef,
        baseCommit: revision,
      },
    };
  };
  return {
    bindPreparedRepository: async (
      identity: RepositoryIdentity & { commit: string; branch: string },
      prepared: PreparedRepositoryWorkspace,
      author?: { name?: string; email?: string },
      transferred?: true,
    ): Promise<WorkerWorkspaceSyncResult & { mode: "repository" }> => {
      if (identity.commit !== prepared.baseCommit) {
        throw new Error("Prepared repository does not match the pinned session commit");
      }
      // Bind the branch and author in one remote command without fetching,
      // resetting, or reseeding the workspace that owns reusable build outputs.
      const bound = await exec({
        argv: ["node", "-e", BIND_PREPARED_REPOSITORY_JS],
        input: JSON.stringify({
          origin: identity.origin,
          commit: identity.commit,
          branch: identity.branch,
          workspaceDir: prepared.workspaceDir,
          author,
          transferred,
        }),
        timeoutMs: GIT_TIMEOUT_MS,
        transportRetry: "never",
      });
      if (!succeeded(bound) || bound.workspaceDir !== prepared.workspaceDir) {
        throw new Error("Prepared repository session binding failed");
      }
      return {
        mode: "repository",
        remoteWorkspaceDir: prepared.workspaceDir,
        manifestRef: prepared.preparedManifestRef,
        baseManifestRef: prepared.sourceManifestRef,
        baseCommit: prepared.baseCommit,
      };
    },
    configureAuthor: async (workspaceDir: string, author: { name?: string; email?: string }) => {
      for (const [key, value] of Object.entries(author)) {
        if (!value) {
          continue;
        }
        const configured = await git([
          "-C",
          workspaceDir,
          "config",
          "--local",
          `user.${key}`,
          value,
        ]);
        if (!succeeded(configured)) {
          throw workspaceSyncError(configured);
        }
      }
    },
    captureManifest: async (dir: string, base: string | null, reference: string) => {
      const captured = await capture(dir, base, reference);
      const manifestRef = captured.stdout.trim();
      if (!succeeded(captured) || !MANIFEST_REF_PATTERN.test(manifestRef)) {
        const detail = boundedWorkerError(
          captured.stderr.trim() ||
            (!succeeded(captured)
              ? `${captured.termination} (exit code ${captured.code}, signal ${captured.signal})`
              : "invalid manifest reference"),
        );
        throw new Error(`Node workspace manifest capture failed: ${detail}`);
      }
      return manifestRef;
    },
    async prepareRepository(
      identity: RepositoryIdentity,
      expectedManifestRef?: string,
    ): Promise<NodeWorkerRepositoryOutcome> {
      const seedKey = createHash("sha256").update(identity.origin).digest("hex");
      let outcome: NodeWorkerRepositoryOutcome | undefined;
      {
        try {
          const applied = await exec({
            argv: ["openclaw-internal-workspace-seed"],
            seed: { action: "apply", key: seedKey },
            timeoutMs: GIT_TIMEOUT_MS,
            transportRetry: "never",
          });
          if (succeeded(applied) && applied.stdout.trim() === "applied") {
            const remote = await git(["remote", "get-url", "origin"]);
            if (!succeeded(remote) || remote.stdout.trim() !== identity.origin) {
              throw new Error("Node workspace seed origin mismatch");
            }
            outcome = await checkoutAndCapture(
              identity,
              applied.workspaceDir,
              expectedManifestRef,
              true,
            );
          }
        } catch (error) {
          authorize?.();
          if (error instanceof Error && error.message.includes("INVALID_REQUEST")) {
            throw error;
          } else {
            // Seeded failure self-heals through the clone path; without this line the
            // degradation would be invisible behind an ordinary "published-origin" sync.
            workspaceSyncLog.info("node worker workspace seeded sync failed; cloning", {
              error: boundedWorkerError(error),
            });
          }
        }
      }
      if (outcome?.kind !== "prepared") {
        const cloned = await git(
          [
            "-c",
            "init.templateDir=",
            "clone",
            "--filter=blob:none",
            "--no-checkout",
            "--",
            identity.origin,
            ".",
          ],
          true,
        );
        if (!succeeded(cloned)) {
          return gitFailure("clone-failed", "git clone", cloned);
        }
        outcome = await checkoutAndCapture(
          identity,
          cloned.workspaceDir,
          expectedManifestRef,
          false,
        );
      }
      if (outcome.kind === "prepared") {
        try {
          const stored = await exec({
            argv: ["openclaw-internal-workspace-seed"],
            seed: { action: "store", key: seedKey, maxAgeMs: 6 * 60 * 60 * 1000 },
            timeoutMs: 180_000,
            transportRetry: "never",
          });
          if (!succeeded(stored)) {
            throw workspaceSyncError(stored);
          }
        } catch (error) {
          authorize?.();
          if (error instanceof Error && error.message.includes("INVALID_REQUEST")) {
            throw error;
          }
          if (!seedStoreFailureLogged) {
            seedStoreFailureLogged = true;
            workspaceSyncLog.warn("node worker workspace seed store failed", {
              error: boundedWorkerError(error),
            });
          }
        }
      }
      if (outcome.kind === "prepared" && identity.branch) {
        const bound = await git(["checkout", "-B", identity.branch, outcome.result.baseCommit]);
        if (!succeeded(bound)) {
          return gitFailure("checkout-failed", "git checkout -B", bound);
        }
      }
      return outcome;
    },
  };
}
