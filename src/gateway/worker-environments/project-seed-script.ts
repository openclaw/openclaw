import { gitMaintenanceEnvironment } from "../../infra/git-maintenance-env.js";
import {
  WORKSPACE_SEED_RETENTION,
  WORKSPACE_SEED_RETENTION_JS,
} from "../../worker/workspace-seed-retention.js";
import { DEFAULT_NODE_TOOLCHAIN_SETUP_SH } from "./node-toolchain.js";
import {
  PREPARE_PROJECT_WORKSPACE_JS,
  PreparedSetupEnvironment,
  type createProjectSetupScript,
  type PreparedProjectVerification,
} from "./project-setup-script.js";

type ProjectSeedScriptInput = {
  namespace: string;
  seedKey: string;
  baseCommit: string;
  projectKey?: string;
  verifiedRetained?: PreparedProjectVerification | null;
  preparation?: Omit<
    Parameters<typeof createProjectSetupScript>[0],
    "namespace" | "seedKey" | "baseCommit"
  >;
  pack?: {
    directory: string;
    sha256: string;
    bytes: number;
    retainedCommit?: string;
    repositoryUrl?: string;
  };
  repository?: { directory?: string; url: string };
};

/** Only immutable Git content and non-secret preparation metadata enter the machine image. */
export function createProjectSeedScript(input: ProjectSeedScriptInput): string {
  if (input.preparation?.setupEnv) {
    PreparedSetupEnvironment.parse(input.preparation.setupEnv);
  }
  // Bootstrap can install a toolchain before Node performs the full seed-path admission.
  return `set -eu
if [ -n "\${HOME:-}" ] && { [ -L "$HOME/.openclaw-worker" ] || [ -L "$HOME/.openclaw-worker/git-seeds" ]; }; then
  echo 'Project seed directory escaped its owner' >&2
  exit 1
fi
${DEFAULT_NODE_TOOLCHAIN_SETUP_SH}
node <<'PROJECT_SEED_SCRIPT'
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const input = ${JSON.stringify(input)};
const retention = ${JSON.stringify(WORKSPACE_SEED_RETENTION)};
${WORKSPACE_SEED_RETENTION_JS}
const prepareWorkspace = ${input.preparation ? PREPARE_PROJECT_WORKSPACE_JS : "undefined"};
const phaseDurationsMs = {};
const startedAt = performance.now();
let phaseStart = performance.now();
const phase = (name) => { const now = performance.now(); phaseDurationsMs[name] = (phaseDurationsMs[name] ?? 0) + Math.round(now - phaseStart); phaseStart = now; };
process.umask(0o077);
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_|GH_TOKEN$|GITHUB_TOKEN$)/i.test(key))), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" };
Object.assign(env, ${JSON.stringify(gitMaintenanceEnvironment())});
const git = (root, args, stdin, networkEnv) => {
  const result = spawnSync("git", ["-c", "core.hooksPath=" + os.devNull, "-c", "core.fsmonitor=false", "-c", "credential.helper=", "-c", "core.askPass=", "-c", "init.templateDir=", "-C", root, ...args], { env: networkEnv ?? env, encoding: "utf8", timeout: 600000, maxBuffer: 262144, stdio: [stdin ?? "ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(networkEnv ? "Project repository fetch failed" : "Project Git preparation failed: " + (result.stderr?.trim() || result.error?.message || "exit " + result.status));
  return result.stdout.trim();
};
const ownedDirectory = (parent, target) => {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory() || path.dirname(fs.realpathSync(target)) !== parent) throw new Error("Project seed directory escaped its owner");
  return stat;
};
(async () => {
  const home = fs.realpathSync(os.homedir());
  const workerRoot = path.join(home, ".openclaw-worker");
  fs.mkdirSync(workerRoot, { recursive: true, mode: 0o700 });
  ownedDirectory(home, workerRoot);
  const root = path.join(workerRoot, "git-seeds");
  fs.mkdirSync(root, { mode: 0o700, recursive: true });
  ownedDirectory(workerRoot, root);
  const namespace = path.join(root, input.namespace);
  fs.mkdirSync(namespace, { recursive: true, mode: 0o700 });
  ownedDirectory(root, namespace);
  const prune = () => {
    const entries = fs.readdirSync(namespace, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, mtimeMs: ownedDirectory(namespace, path.join(namespace, entry.name)).mtimeMs }));
    for (const entry of selectWorkspaceSeedsToPrune(entries, retention, Date.now(), input.seedKey)) {
      const target = path.join(namespace, entry.name);
      if (ownedDirectory(namespace, target).mtimeMs === entry.mtimeMs) fs.rmSync(target, { recursive: true });
    }
  };
  const seed = path.join(namespace, input.seedKey);
  const stagingPrefix = ".tmp-" + input.seedKey + "-";
  if (input.pack && input.repository) throw new Error("Project seed transports are mutually exclusive");
  const transport = input.pack ?? input.repository;
  let directory = transport?.directory;
  if (directory !== undefined) {
    if (path.dirname(directory) !== namespace || !path.basename(directory).startsWith(stagingPrefix)) throw new Error("Project staging path escaped its owner");
    ownedDirectory(namespace, directory);
  }
  try {
    phase("seedPreparation");
    const retained = input.preparation && await prepareWorkspace({ ...input, ...input.preparation }, true, phaseDurationsMs);
    input.verifiedRetained = retained ? { baseCommit: retained.baseCommit, sourceManifestRef: retained.sourceManifestRef, preparedManifestRef: retained.preparedManifestRef } : null;
    const retainedSeedKey = retained && input.projectKey ? crypto.createHash("sha256").update(input.projectKey + "\\0" + retained.baseCommit).digest("hex") : undefined;
    phaseStart = performance.now();
    const retainedWorkspace = input.preparation ? { retainedWorkspace: retained ?? null } : {};
    if (directory === undefined) {
      if (fs.existsSync(seed)) {
        ownedDirectory(namespace, seed);
        ownedDirectory(seed, path.join(seed, ".git"));
        const preparedWorkspace = retained?.baseCommit === input.baseCommit ? retained : undefined;
        if (git(seed, ["rev-parse", "--verify", "HEAD"]) !== input.baseCommit || git(seed, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("Prepared project seed is not pristine");
        phase("seedVerification");
        prune();
        phase("seedPreparation");
        return { ready: true, cacheHit: true, preparedWorkspace, ...retainedWorkspace };
      }
      // Provisioning serializes this lease. Discard only this project's abandoned staging.
      for (const entry of fs.readdirSync(namespace)) {
        if (!entry.startsWith(stagingPrefix)) continue;
        const stale = path.join(namespace, entry);
        ownedDirectory(namespace, stale);
        fs.rmSync(stale, { recursive: true });
      }
      directory = fs.mkdtempSync(path.join(namespace, stagingPrefix));
      phase("seedPreparation");
      if (!transport) return { ready: false, directory, ...retainedWorkspace };
    }
    const repository = path.join(directory, "repository");
    let reused = false;
    if (retainedSeedKey && retained) {
      const donor = path.join(namespace, retainedSeedKey);
      try {
        ownedDirectory(namespace, donor);
        ownedDirectory(donor, path.join(donor, ".git"));
        reused = git(donor, ["rev-parse", "--verify", "HEAD"]) === retained.baseCommit && !git(donor, ["status", "--porcelain=v1", "--untracked-files=all"]);
      } catch { /* Missing or unusable retained seeds use the fresh path. */ }
      // A failure after this move consumes the donor; the next attempt starts fresh.
      if (reused) fs.renameSync(donor, repository);
    }
    if (!reused) {
      fs.mkdirSync(repository, { mode: 0o700 });
      git(repository, ["init", "--quiet", "--object-format=" + (input.baseCommit.length === 40 ? "sha1" : "sha256"), "."]);
    }
    const repositoryUrl = input.repository?.url ?? input.pack?.repositoryUrl;
    if (repositoryUrl !== undefined) {
      const url = new URL(repositoryUrl);
      const segments = url.pathname.slice(1).split("/");
      if (url.protocol !== "https:" || (input.repository && url.origin !== "https://github.com") || url.href !== repositoryUrl || url.username || url.password || url.search || url.hash || segments.length !== 2 || segments.some((segment) => !/^[A-Za-z0-9_.-]+$/.test(segment)) || !segments[1].endsWith(".git") || !/^[a-f0-9]{40}$/.test(input.baseCommit)) throw new Error("Project repository source is invalid");
    }
    if (input.repository) {
      // Public fetches cannot use ambient credentials, helpers, or redirects.
      // Git enables libcurl's netrc lookup independently of credential helpers.
      const authHome = fs.mkdtempSync(path.join(directory, ".fetch-home-"));
      const networkEnv = { ...Object.fromEntries(Object.entries(env).filter(([key]) => !/^(HOME|USERPROFILE|NETRC)$/i.test(key))), HOME: authHome, USERPROFILE: authHome };
      // Detached HEAD is not advertised by default; name it to negotiate the retained objects.
      git(repository, ["-c", "fetch.unpackLimit=1", "-c", "fetch.fsckObjects=true", "-c", "http.followRedirects=false", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "fetch", "--depth=1", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", ...(reused ? ["--negotiation-tip=HEAD"] : []), repositoryUrl, input.baseCommit], undefined, networkEnv);
    } else {
      const pack = path.join(directory, "base.pack");
      const stat = fs.lstatSync(pack);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== input.pack.bytes) throw new Error("Project pack size does not match");
      const hash = crypto.createHash("sha256");
      for await (const chunk of fs.createReadStream(pack)) hash.update(chunk);
      if (hash.digest("hex") !== input.pack.sha256) throw new Error("Project pack digest does not match");
      if (input.pack.retainedCommit) {
        if (retained?.baseCommit !== input.pack.retainedCommit) throw new Error("Prepared project retained Git base changed before transfer");
        // Fetch one local snapshot into independent objects, without alternates or
        // ancestors that the retained checkout may never have received.
        if (!reused) git(repository, ["-c", "fetch.unpackLimit=1", "fetch", "--depth=1", "--no-tags", "--no-write-fetch-head", "--update-shallow", retained.workspaceDir, input.pack.retainedCommit]);
      }
      fs.writeFileSync(path.join(repository, ".git", "shallow"), [...new Set([input.baseCommit, input.pack.retainedCommit].filter(Boolean))].join("\\n") + "\\n", { mode: 0o600 });
      const fd = fs.openSync(pack, "r");
      try { git(repository, ["index-pack", "--strict", "--stdin", "--fix-thin"], fd); } finally { fs.closeSync(fd); }
    }
    phase("seedTransfer");
    // Session workspace binding verifies this credential-free source identity.
    if (repositoryUrl !== undefined) {
      if (reused) {
        if (git(repository, ["remote", "get-url", "origin"]) !== repositoryUrl) throw new Error("Project seed source changed");
      } else git(repository, ["remote", "add", "origin", repositoryUrl]);
    }
    if (git(repository, ["rev-parse", "--verify", input.baseCommit + "^{commit}"]) !== input.baseCommit) throw new Error("Project seed commit does not match");
    if (reused) git(repository, ["rev-list", "--objects", "--quiet", "--missing=error", input.baseCommit, "^" + retained.baseCommit]);
    else git(repository, ["fsck", "--full", "--strict", "--no-reflogs", input.baseCommit]);
    phase("seedVerification");
    if (reused) git(repository, ["update-index", "-q", "--refresh"]);
    git(repository, ["checkout", "--detach", "--force", input.baseCommit]);
    if (git(repository, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("Prepared project checkout is not pristine");
    fs.renameSync(repository, seed);
    prune();
    phase("seedCheckout");
    return { ready: true, cacheHit: false, ...retainedWorkspace };
  } finally { phaseStart = performance.now(); if (transport && directory !== undefined) fs.rmSync(directory, { recursive: true, force: true }); phase("seedPreparation"); }
})().then(async (result) => {
  // Only budgeted runs may execute repository code. Seed time consumes that same budget.
  if (result.ready && !result.preparedWorkspace && input.preparation && (input.preparation.timeoutMs !== undefined || (result.cacheHit === false && (!input.preparation.setupRecipe || input.preparation.runSetupScript === false)))) {
    result.preparedWorkspace = await prepareWorkspace({ ...input, ...input.preparation, ...(input.preparation.timeoutMs !== undefined ? { timeoutMs: Math.floor(input.preparation.timeoutMs - (performance.now() - startedAt)) } : { runSetupScript: false }) }, false, phaseDurationsMs);
  }
  process.stdout.write(JSON.stringify({ ...result, phaseDurationsMs }));
}).catch((error) => { console.error(error.message); process.exitCode = 1; });
PROJECT_SEED_SCRIPT`;
}
