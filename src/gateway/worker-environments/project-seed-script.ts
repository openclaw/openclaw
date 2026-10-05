import { copyWorkspaceSeedGitObjects } from "../../worker/workspace-seed-objects.js";
import {
  WORKSPACE_SEED_RETENTION,
  WORKSPACE_SEED_RETENTION_JS,
} from "../../worker/workspace-seed-retention.js";
import {
  PREPARE_PROJECT_WORKSPACE_JS,
  type PreparedProjectVerification,
} from "./project-setup-script.js";
import {
  MAX_WORKSPACE_GIT_CANDIDATES,
  MAX_WORKSPACE_INVENTORY_TOTAL_BYTES,
} from "./workspace-inventory-limits.js";

type ProjectSeedScriptInput = {
  namespace: string;
  seedKey: string;
  baseCommit: string;
  repositoryUrl?: string;
  verifiedRetained?: PreparedProjectVerification | null;
  preparation?: {
    preparationKey: string;
    cacheKey: string;
    setupRecipe?: string;
    runSetupScript?: boolean;
  };
  pack?: {
    directory: string;
    sha256: string;
    bytes: number;
    retainedCommit?: string;
    repositoryUrl?: string;
  };
  repository?: { directory: string; url: string };
};

/** Only immutable Git content and non-secret preparation metadata enter the machine image. */
export function createProjectSeedScript(input: ProjectSeedScriptInput): string {
  return `set -eu
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
const copySeedObjects = ${copyWorkspaceSeedGitObjects.toString()};
process.umask(0o077);
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_|GH_TOKEN$|GITHUB_TOKEN$)/i.test(key))), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" };
const git = (root, args, stdin, networkEnv) => {
  const result = spawnSync("git", ["-c", "core.hooksPath=" + os.devNull, "-c", "core.fsmonitor=false", "-c", "credential.helper=", "-c", "core.askPass=", "-c", "init.templateDir=", "-C", root, ...args], { env: networkEnv ?? env, encoding: "utf8", timeout: 600000, maxBuffer: 262144, input: typeof stdin === "string" ? stdin : undefined, stdio: [typeof stdin === "string" ? "pipe" : stdin ?? "ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(networkEnv ? "Project repository fetch failed" : "Project Git preparation failed: " + (result.stderr?.trim() || result.error?.message || "exit " + result.status));
  return result.stdout.trim();
};
const ownedDirectory = (parent, target) => {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory() || path.dirname(fs.realpathSync(target)) !== parent) throw new Error("Project seed directory escaped its owner");
  return stat;
};
const exists = (target) => {
  try { fs.lstatSync(target); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
};
const repositoryUrl = input.repositoryUrl ?? input.repository?.url ?? input.pack?.repositoryUrl;
if (repositoryUrl !== undefined) {
  const url = new URL(repositoryUrl);
  const segments = url.pathname.slice(1).split("/");
  if (url.protocol !== "https:" || (input.repository && url.origin !== "https://github.com") || url.href !== repositoryUrl || url.username || url.password || url.search || url.hash || segments.length !== 2 || segments.some((segment) => !/^[A-Za-z0-9_.-]+$/.test(segment)) || !segments[1].endsWith(".git") || !/^[a-f0-9]{40}$/.test(input.baseCommit) || [input.repository?.url, input.pack?.repositoryUrl].some((source) => source !== undefined && source !== repositoryUrl)) throw new Error("Project repository source is invalid");
}
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
  const importImageDonor = async (directory) => {
    if (repositoryUrl === undefined) return false;
    const donors = path.join(workerRoot, "prepared-git-seeds");
    if (!exists(donors)) return false;
    ownedDirectory(workerRoot, donors);
    const key = crypto.createHash("sha256").update(repositoryUrl).digest("hex");
    const donor = path.join(donors, key);
    if (!exists(donor)) return false;
    ownedDirectory(donors, donor);
    const inventoryPath = "/opt/teamclaw/repositories.json";
    const inventoryStat = fs.lstatSync(inventoryPath);
    if (!inventoryStat.isFile() || inventoryStat.isSymbolicLink() || inventoryStat.size > 1048576) throw new Error("Prepared image repository inventory is invalid");
    const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
    if (!Array.isArray(inventory)) throw new Error("Prepared image repository inventory is invalid");
    const rows = inventory.filter((row) => row && row.key === key);
    const row = rows[0];
    if (rows.length !== 1 || row.origin !== repositoryUrl || !/^[a-f0-9]{40}$/.test(row.commit) || typeof row.sourceRef !== "string" || !row.sourceRef || row.sourceRef.length > 1024 || !/^[a-f0-9]{64}$/.test(row.bundleSha256)) throw new Error("Prepared image repository inventory does not match its donor");
    const admin = path.join(donor, ".git");
    ownedDirectory(donor, admin);
    const objects = path.join(admin, "objects");
    ownedDirectory(admin, objects);
    if (exists(path.join(objects, "info", "alternates"))) throw new Error("Prepared image Git donor is not standalone");
    // Producer refs and bundle digests are provenance, never the current target.
    if (git(donor, ["remote", "get-url", "origin"]) !== repositoryUrl || git(donor, ["rev-parse", "--verify", "HEAD"]) !== row.commit || git(donor, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("Prepared image Git donor identity is invalid");
    const repository = path.join(directory, "repository");
    fs.mkdirSync(repository, { mode: 0o700 });
    git(repository, ["init", "--quiet", "--object-format=sha1", "."]);
    await copySeedObjects({ filesystem: fs.promises, paths: path, source: objects, destination: path.join(repository, ".git", "objects"), maxEntries: ${MAX_WORKSPACE_GIT_CANDIDATES}, maxBytes: ${MAX_WORKSPACE_INVENTORY_TOTAL_BYTES} });
    fs.writeFileSync(path.join(repository, ".git", "shallow"), row.commit + "\\n", { mode: 0o600 });
    if (git(repository, ["rev-parse", "--verify", row.commit + "^{commit}"]) !== row.commit) throw new Error("Prepared image Git donor commit is invalid");
    git(repository, ["fsck", "--full", "--strict", "--no-reflogs", row.commit]);
    const available = git(repository, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], input.baseCommit + "\\n");
    if (available === input.baseCommit + " missing") {
      fs.rmSync(repository, { recursive: true });
      return false;
    }
    if (available !== input.baseCommit + " commit") throw new Error("Prepared image Git target is not a commit");
    fs.writeFileSync(path.join(repository, ".git", "shallow"), input.baseCommit + "\\n", { mode: 0o600 });
    git(repository, ["fsck", "--full", "--strict", "--no-reflogs", input.baseCommit]);
    git(repository, ["remote", "add", "origin", repositoryUrl]);
    git(repository, ["checkout", "--detach", "--force", input.baseCommit]);
    // Keep only the admitted committed snapshot, not unreachable donor objects.
    git(repository, ["repack", "-ad"]);
    git(repository, ["prune", "--expire=now"]);
    if (git(repository, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("Prepared image project checkout is not pristine");
    fs.renameSync(repository, seed);
    return true;
  };
  const stagingPrefix = ".tmp-" + input.seedKey + "-";
  if (input.pack && input.repository) throw new Error("Project seed transports are mutually exclusive");
  const transport = input.pack ?? input.repository;
  const directory = transport?.directory;
  if (directory !== undefined) {
    if (path.dirname(directory) !== namespace || !path.basename(directory).startsWith(stagingPrefix)) throw new Error("Project staging path escaped its owner");
    ownedDirectory(namespace, directory);
  }
  try {
    const retained = input.preparation && await prepareWorkspace({ ...input, ...input.preparation }, true);
    const retainedWorkspace = input.preparation ? { retainedWorkspace: retained ?? null } : {};
    if (!transport) {
      if (fs.existsSync(seed)) {
        ownedDirectory(namespace, seed);
        ownedDirectory(seed, path.join(seed, ".git"));
        const preparedWorkspace = retained?.baseCommit === input.baseCommit ? retained : undefined;
        if (git(seed, ["rev-parse", "--verify", "HEAD"]) !== input.baseCommit || git(seed, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("Prepared project seed is not pristine");
        if (repositoryUrl !== undefined && git(seed, ["remote", "get-url", "origin"]) !== repositoryUrl) throw new Error("Prepared project seed origin does not match");
        prune();
        process.stdout.write(JSON.stringify({ ready: true, preparedWorkspace, ...retainedWorkspace }));
        return;
      }
      // Provisioning serializes this lease. Discard only this project's abandoned staging.
      for (const entry of fs.readdirSync(namespace)) {
        if (!entry.startsWith(stagingPrefix)) continue;
        const stale = path.join(namespace, entry);
        ownedDirectory(namespace, stale);
        fs.rmSync(stale, { recursive: true });
      }
      const directory = fs.mkdtempSync(path.join(namespace, stagingPrefix));
      try {
        if (await importImageDonor(directory)) {
          fs.rmSync(directory, { recursive: true });
          prune();
          const preparedWorkspace = retained?.baseCommit === input.baseCommit ? retained : undefined;
          process.stdout.write(JSON.stringify({ ready: true, preparedWorkspace, ...retainedWorkspace }));
          return;
        }
      } catch (error) {
        fs.rmSync(directory, { recursive: true, force: true });
        throw error;
      }
      process.stdout.write(JSON.stringify({ ready: false, directory, ...retainedWorkspace }));
      return;
    }
    const repository = path.join(directory, "repository");
    fs.mkdirSync(repository, { mode: 0o700 });
    git(repository, ["init", "--quiet", "--object-format=" + (input.baseCommit.length === 40 ? "sha1" : "sha256"), "."]);
    if (input.repository) {
      // Public fetches cannot use ambient credentials, helpers, or redirects.
      // Git enables libcurl's netrc lookup independently of credential helpers.
      const authHome = fs.mkdtempSync(path.join(directory, ".fetch-home-"));
      const networkEnv = { ...Object.fromEntries(Object.entries(env).filter(([key]) => !/^(HOME|USERPROFILE|NETRC)$/i.test(key))), HOME: authHome, USERPROFILE: authHome };
      git(repository, ["-c", "http.followRedirects=false", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "fetch", "--depth=1", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", repositoryUrl, input.baseCommit], undefined, networkEnv);
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
        git(repository, ["fetch", "--depth=1", "--no-tags", "--no-write-fetch-head", "--update-shallow", retained.workspaceDir, input.pack.retainedCommit]);
      }
      fs.writeFileSync(path.join(repository, ".git", "shallow"), [...new Set([input.baseCommit, input.pack.retainedCommit].filter(Boolean))].join("\\n") + "\\n", { mode: 0o600 });
      const fd = fs.openSync(pack, "r");
      try { git(repository, ["index-pack", "--stdin", "--fix-thin"], fd); } finally { fs.closeSync(fd); }
    }
    // Session workspace binding verifies this credential-free source identity.
    if (repositoryUrl !== undefined) git(repository, ["remote", "add", "origin", repositoryUrl]);
    if (git(repository, ["rev-parse", "--verify", input.baseCommit + "^{commit}"]) !== input.baseCommit) throw new Error("Project seed commit does not match");
    git(repository, ["fsck", "--full", "--strict", "--no-reflogs", input.baseCommit]);
    git(repository, ["checkout", "--detach", "--force", input.baseCommit]);
    if (git(repository, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("Prepared project checkout is not pristine");
    fs.renameSync(repository, seed);
    prune();
    // Repository code keeps its separate Gateway authority check. A checkout that
    // cannot run setup can complete under this seed command's existing owner.
    const preparedWorkspace = input.preparation && (!input.preparation.setupRecipe || input.preparation.runSetupScript === false)
      ? await prepareWorkspace({ ...input, ...input.preparation, runSetupScript: false })
      : undefined;
    process.stdout.write(JSON.stringify({ ready: true, preparedWorkspace }));
  } finally { if (directory !== undefined) fs.rmSync(directory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
PROJECT_SEED_SCRIPT`;
}
