import { z } from "zod";
import { gitMaintenanceEnvironmentExpression } from "../../infra/git-maintenance-env.js";
import type { WorkerProvider } from "../../plugins/capability-provider.types.js";
import type { EnvironmentRecipe, LifecycleCommand } from "./environment-recipe.js";
import { DEFAULT_NODE_TOOLCHAIN_SETUP_SH } from "./node-toolchain.js";
import { PREPARE_REPOSITORY_NODE_JS } from "./repository-node-toolchain.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  MAX_WORKSPACE_INVENTORY_ENTRIES,
  MAX_WORKSPACE_MANIFEST_BYTES,
} from "./workspace-inventory-limits.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";

const PreparedSetupEnvironment = z
  .record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
    z
      .string()
      .max(4096)
      .refine((value) => !value.includes("\0")),
  )
  .refine(
    (env) => Object.keys(env).length <= 32 && Buffer.byteLength(JSON.stringify(env)) <= 32768,
    "Prepared setup environment exceeds its limit",
  );

export type PreparedProjectVerification = {
  baseCommit: string;
  sourceManifestRef: string;
  preparedManifestRef: string;
};

const RUN_ENVIRONMENT_COMMAND_JS = `async (command, context) => {
const { spawn } = require("node:child_process");
const { workspaceDir, homeDir, timeoutMs, env = {}, settleDescendants = true } = context;
const run = async (command) => {
if (command && !Array.isArray(command) && typeof command === "object") {
  const results = await Promise.allSettled(Object.values(command).map(run));
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  return results.map((result) => result.value).filter(Boolean).join("\\n");
}
const argv = typeof command === "string" ? ["/bin/sh", "-c", command] : command;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error("Prepared project command budget exhausted");
  let child;
  let timeout;
  let stderr = Buffer.alloc(0);
  let failure;
  // A deadline/signal may retire the group before exit; never signal that group twice.
  let killed = false;
  const killGroup = () => {
    if (child?.pid && !killed) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      killed = true;
    }
  };
  const stop = (reason) => { failure ??= reason; killGroup(); };
  const signals = ["SIGTERM", "SIGINT"].map((signal) => [signal, () => stop("interrupted by " + signal)]);
  // A recipe can signal its parent before spawn returns. Own those signals
  // before it starts, and release them even when spawn throws synchronously.
  for (const [signal, handler] of signals) process.once(signal, handler);
  return new Promise((resolve, reject) => {
    child = spawn(argv[0], argv.slice(1), {
      cwd: workspaceDir,
      env: Object.fromEntries(Object.entries({ PATH: process.env.PATH, HOME: homeDir, LANG: "C.UTF-8", ...env, OPENCLAW_SOURCE_TREE_PATH: workspaceDir, OPENCLAW_WORKTREE_PATH: workspaceDir }).filter(([, value]) => value !== null)),
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    timeout = setTimeout(() => stop("timed out within the provider command budget (" + Math.ceil(timeoutMs) + " ms)"), timeoutMs);
    child.stderr.on("data", (chunk) => {
      stderr = Buffer.concat([stderr, chunk]).subarray(-16384);
      let start = 0;
      while (start < stderr.length && (stderr[start] & 0xc0) === 0x80) start++;
      stderr = stderr.subarray(start);
    });
    child.once("error", (error) => { failure ??= error.message; });
    // Preparation must settle descendants before capture. Successful post-binding
    // services live until worker teardown; close our diagnostic pipe without killing them.
    child.once("exit", (code) => {
      if (settleDescendants || code !== 0 || failure) killGroup();
      else child.stderr.destroy();
    });
    child.once("close", (code) => {
      // Invalid UTF-8 expands when decoded; bound the serialized text as well as raw bytes.
      const output = Buffer.from(stderr.toString("utf8"));
      let start = Math.max(0, output.length - 16384);
      while (start < output.length && (output[start] & 0xc0) === 0x80) start++;
      const outputTail = output.subarray(start).toString("utf8");
      if (code !== 0 || failure) {
        const error = new Error("Prepared project setup failed: " + (failure || "exit " + code));
        error.outputTail = outputTail;
        reject(error);
      } else resolve(outputTail);
    });
  }).finally(() => {
    clearTimeout(timeout);
    for (const [signal, handler] of signals) process.removeListener(signal, handler);
  });
};
return await run(command);
}`;

export const PREPARE_PROJECT_WORKSPACE_JS = `async (input, inspectOnly = false) => {
const startedAt = performance.now();
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const manifestScript = ${JSON.stringify(REMOTE_WORKSPACE_MANIFEST_JS)};
process.umask(0o077);
const machineHome = fs.realpathSync(os.homedir());
let setupPath = process.env.PATH;
const env = { PATH: process.env.PATH, HOME: machineHome, LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, ...${gitMaintenanceEnvironmentExpression(
  [
    [JSON.stringify("core.hooksPath"), "os.devNull"],
    [JSON.stringify("core.fsmonitor"), JSON.stringify("false")],
  ],
)}, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" };
const ownedDirectory = (parent, name, create = false) => {
  const target = path.join(parent, name);
  if (create && !fs.existsSync(target)) fs.mkdirSync(target, { mode: 0o700 });
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(target) !== target) throw new Error("Prepared project directory escaped its owner");
  return target;
};
const git = (root, args) => {
  // Full object verification on cold snapshot storage needs the same budget as seed verification.
  const timeout = 600000;
  const maxBuffer = 262144;
  const result = spawnSync("git", ["-C", root, ...args], { env, encoding: "utf8", timeout, maxBuffer });
  if (result.error || result.status !== 0) {
    const reason = result.error?.code === "ETIMEDOUT" ? "timed out after " + timeout + " ms"
      : result.error?.code === "ENOBUFS" ? "output exceeded " + maxBuffer + " bytes"
      : result.error?.code ?? (result.signal ? "signal " + result.signal : "exit " + result.status);
    // Git output and full arguments can contain private repository paths or contents.
    throw new Error("Prepared project Git verification failed (git " + args[0] + ": " + reason + ")");
  }
  return result.stdout.trim();
};
const manifest = (root, baseCommit = input.baseCommit, priorRefs = [], manifestHome = machineHome) => {
  const result = spawnSync(process.execPath, ["-e", manifestScript, root, baseCommit, "eligible", ...priorRefs.map((ref) => ref.slice(7))], { env: { ...env, HOME: manifestHome }, encoding: "utf8", timeout: 600000, maxBuffer: 262144 });
  if (result.status !== 0 || !/^sha256:[a-f0-9]{64}$/.test(result.stdout.trim())) throw new Error("Prepared project manifest verification failed: " + (result.stderr?.trim() || result.error?.message || result.status));
  return result.stdout.trim();
};
const readManifest = (file, ref) => {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > ${MAX_WORKSPACE_MANIFEST_BYTES}) throw new Error("Prepared project manifest is unsafe");
    const bytes = fs.readFileSync(fd);
    if ("sha256:" + crypto.createHash("sha256").update(bytes).digest("hex") !== ref) throw new Error("Prepared project source manifest changed");
    return bytes;
  } finally { fs.closeSync(fd); }
};
const singleArtifact = (directory, pattern) => {
  const entries = fs.opendirSync(directory);
  try {
    const entry = entries.readSync();
    if (!entry || !pattern.test(entry.name) || entries.readSync()) throw new Error("Prepared project completion artifact is invalid");
    return entry.name;
  } finally { entries.closeSync(); }
};
const manifestEntries = (bytes, baseCommit) => {
  const value = JSON.parse(bytes);
  if (value.version !== 1 || value.baseCommit !== baseCommit || !Array.isArray(value.entries) || value.entries.length > ${MAX_WORKSPACE_INVENTORY_ENTRIES}) throw new Error("Prepared project manifest is invalid");
  for (const entry of value.entries) {
    const relative = entry.path;
    if (typeof relative !== "string" || !relative || relative.includes("\\\\") || path.posix.isAbsolute(relative) || path.posix.normalize(relative) !== relative || relative === "." || relative === ".." || relative.startsWith("../") || relative === ".git" || relative.startsWith(".git/") || !["file", "directory", "symlink"].includes(entry.type)) throw new Error("Prepared project manifest path is unsafe");
  }
  return value.entries;
};
const removeSetupOutputs = (workspaceDir, previous) => {
  const baseline = manifestEntries(previous.sourceBytes, previous.baseCommit);
  const prepared = manifestEntries(previous.preparedBytes, previous.baseCommit);
  const baselineFiles = new Set(baseline.filter((entry) => entry.type !== "directory").map((entry) => entry.path));
  const baselineDirectories = new Set(baseline.filter((entry) => entry.type === "directory").map((entry) => entry.path));
  const targetPath = (relative) => {
    const segments = relative.split("/");
    let parent = workspaceDir;
    for (const segment of segments.slice(0, -1)) parent = ownedDirectory(parent, segment);
    return path.join(parent, segments.at(-1));
  };
  // Remove obsolete eligible setup output here. Git owns replacement of newly
  // tracked paths; unrelated ignored dependency/build caches remain in place.
  for (const entry of prepared) {
    if (entry.type !== "directory" && !baselineFiles.has(entry.path)) fs.unlinkSync(targetPath(entry.path));
  }
  for (const entry of prepared.filter((entry) => entry.type === "directory" && !baselineDirectories.has(entry.path)).sort((left, right) => right.path.split("/").length - left.path.split("/").length)) {
    const target = targetPath(entry.path);
    ownedDirectory(path.dirname(target), path.basename(target));
    if (fs.readdirSync(target).length === 0) fs.rmdirSync(target);
  }
};
const runSetup = (command, workspaceDir, homeDir) => {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs > 2147483647) throw new Error("Prepared project command budget exhausted");
  return (${RUN_ENVIRONMENT_COMMAND_JS})(command, {
    workspaceDir, homeDir, env: { PATH: setupPath, ...input.recipe?.env, ...input.setupEnv },
    timeoutMs: input.timeoutMs - (performance.now() - startedAt),
  });
};
  const workerRoot = ownedDirectory(machineHome, ".openclaw-worker");
  const existing = path.join(workerRoot, "prepared", input.namespace, input.cacheKey);
  const exists = fs.existsSync(existing);
  const verified = input.verifiedRetained;
  if (verified !== undefined && (verified !== null) !== exists) throw new Error("Prepared project changed during preparation");
  // Inspection cannot create a workspace or execute repository code before the Gateway rechecks its owner.
  if (inspectOnly && !exists) return;
  let previous;
  if (exists) {
    const parent = ownedDirectory(ownedDirectory(workerRoot, "prepared"), input.namespace);
    const directory = ownedDirectory(parent, input.cacheKey);
    const workspaceDir = ownedDirectory(directory, "workspace");
    const homeDir = ownedDirectory(directory, "home");
    const admin = ownedDirectory(workspaceDir, ".git");
    if (fs.existsSync(path.join(admin, "objects", "info", "alternates")) || fs.existsSync(path.join(admin, "info", "grafts"))) throw new Error("Prepared project Git base is not standalone");
    const baseCommit = git(workspaceDir, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baseCommit)) throw new Error("Prepared project Git base is invalid");
    if (verified === undefined) git(workspaceDir, ["fsck", "--full", "--strict", "--no-reflogs", baseCommit]);
    const manifestRoot = ownedDirectory(ownedDirectory(homeDir, ".openclaw-worker"), "manifests");
    const completionRoot = ownedDirectory(manifestRoot, "prepared");
    const sourceDigest = singleArtifact(completionRoot, /^[a-f0-9]{64}$/);
    const completionDirectory = ownedDirectory(completionRoot, sourceDigest);
    const preparedFile = singleArtifact(completionDirectory, /^[a-f0-9]{64}[.]json$/);
    const sourceManifestRef = "sha256:" + sourceDigest;
    const preparedManifestRef = "sha256:" + preparedFile.slice(0, -5);
    if (verified && (baseCommit !== verified.baseCommit || sourceManifestRef !== verified.sourceManifestRef || preparedManifestRef !== verified.preparedManifestRef)) throw new Error("Prepared project changed during preparation");
    const completedManifest = path.join(completionDirectory, preparedFile);
    const sourceBytes = readManifest(path.join(manifestRoot, sourceDigest + ".json"), sourceManifestRef);
    const preparedBytes = readManifest(completedManifest, preparedManifestRef);
    readManifest(path.join(manifestRoot, preparedFile), preparedManifestRef);
    manifestEntries(sourceBytes, baseCommit);
    if (verified === undefined && manifest(workspaceDir, baseCommit, [preparedManifestRef, sourceManifestRef], homeDir) !== preparedManifestRef) throw new Error("Prepared project completed workspace changed");
    previous = { workspaceDir, homeDir, sourceManifestRef, preparedManifestRef, baseCommit, sourceBytes, preparedBytes, completedManifest, completionDirectory, manifestRoot };
    if (inspectOnly) return { workspaceDir, homeDir, sourceManifestRef, preparedManifestRef, baseCommit };
  }
  const seeds = ownedDirectory(ownedDirectory(workerRoot, "git-seeds"), input.namespace);
  const seed = ownedDirectory(seeds, input.seedKey);
  ownedDirectory(seed, ".git");
  if (git(seed, ["rev-parse", "HEAD"]) !== input.baseCommit || git(seed, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("Prepared project seed is not pristine");
  const recipe = input.recipe ?? {
    source: input.setupRecipe ? "script" : "none", env: {},
    inputs: input.setupRecipe ? { ".openclaw/worktree-setup.sh": input.setupRecipe } : {},
    ...(input.setupRecipe ? { onCreate: ["./.openclaw/worktree-setup.sh"] } : {}),
  };
  const verifyRecipe = (root, afterSetup = false) => {
    for (const [file, blob] of Object.entries(recipe.inputs)) {
      const tree = git(root, ["ls-tree", input.baseCommit, "--", file]);
      const mode = recipe.source === "script" ? "100755" : "100(?:644|755)";
      let parent = root;
      const segments = file.split("/");
      for (const segment of segments.slice(0, -1)) parent = ownedDirectory(parent, segment);
      const target = path.join(parent, segments.at(-1));
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || (recipe.source === "script" && (stat.mode & 0o111) === 0)) throw new Error("Prepared project setup recipe is not an executable regular file");
      if (!(new RegExp("^" + mode + " blob " + blob + "\\t")).test(tree) || git(root, ["hash-object", "--", target]) !== blob) throw new Error(afterSetup ? "Prepared project setup recipe changed during setup" : "Prepared project setup recipe differs from its admission");
    }
    if (!input.recipe && !input.setupRecipe && git(root, ["ls-tree", input.baseCommit, "--", ".openclaw/worktree-setup.sh"]).startsWith("100755 ")) throw new Error("Prepared project setup recipe differs from its admission");
  };
  verifyRecipe(seed);
  const sourceManifestRef = manifest(seed);
  const sourceFile = path.join(workerRoot, "manifests", sourceManifestRef.slice(7) + ".json");
  const sourceBytes = readManifest(sourceFile, sourceManifestRef);
  const preparedRoot = ownedDirectory(ownedDirectory(workerRoot, "prepared", true), input.namespace, true);
  const directory = path.join(preparedRoot, input.cacheKey);
  const fresh = !fs.existsSync(directory);
  ownedDirectory(preparedRoot, input.cacheKey, fresh);
  if (fresh) {
    fs.mkdirSync(path.join(directory, "home"), { mode: 0o700 });
    fs.cpSync(seed, path.join(directory, "workspace"), { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  }
  const workspaceDir = ownedDirectory(directory, "workspace");
  const homeDir = ownedDirectory(directory, "home");
  const manifestRoot = ownedDirectory(ownedDirectory(homeDir, ".openclaw-worker", fresh), "manifests", fresh);
  const completionRoot = ownedDirectory(manifestRoot, "prepared", fresh);
  const changed = previous && previous.baseCommit !== input.baseCommit;
  if (changed) {
    // Invalidate the only completion witness before touching Git or running code.
    // An interrupted update cannot replay setup, even when returning to an older commit.
    fs.unlinkSync(previous.completedManifest);
    fs.rmdirSync(previous.completionDirectory);
    for (const ref of new Set([previous.sourceManifestRef, previous.preparedManifestRef])) fs.unlinkSync(path.join(manifestRoot, ref.slice(7) + ".json"));
    // onCreate is not repeated for a content refresh; retain its generated artifacts.
    if (recipe.source !== "devcontainer") removeSetupOutputs(workspaceDir, previous);
    git(workspaceDir, ["fetch", "--depth=1", "--no-tags", "--no-write-fetch-head", "--update-shallow", seed, input.baseCommit]);
    git(workspaceDir, ["checkout", "--detach", "--force", input.baseCommit]);
  } else if (!fresh && previous.sourceManifestRef !== sourceManifestRef) {
    throw new Error("Prepared project pristine baseline changed");
  }
  if (fresh || changed) setupPath = await (${PREPARE_REPOSITORY_NODE_JS})(workspaceDir, homeDir, machineHome) ?? setupPath;
  const recipePreparation = { source: recipe.source, ...(recipe.ignoredPropertiesNote ? { ignoredPropertiesNote: recipe.ignoredPropertiesNote } : {}), phaseDurationsMs: {} };
  let setupFailure;
  let captureSkipped;
  if ((fresh || changed) && input.runSetupScript !== false) {
    const phases = recipe.source === "detected"
      ? [["detectedInstall", recipe.detectedInstall]]
      : [...(fresh ? [["onCreate", recipe.onCreate]] : recipe.source === "script" ? [["onCreate", recipe.onCreate]] : []), ["updateContent", recipe.updateContent]];
    for (const [phase, command] of phases) {
      if (command === undefined) continue;
      const phaseStart = performance.now();
      try {
        const note = await runSetup(command, workspaceDir, homeDir);
        if (recipe.source === "detected" && note.trim()) recipePreparation.note = note.trim();
      } catch (error) {
        recipePreparation.failure = { reason: error.message, ...(error.outputTail ? { outputTail: error.outputTail } : {}) };
        if (recipe.source === "detected") captureSkipped = "Detected dependency installation failed; starting without a snapshot";
        else setupFailure = error.message;
        break;
      } finally { recipePreparation.phaseDurationsMs[phase] = Math.round(performance.now() - phaseStart); }
    }
  }
  if (setupFailure) return { recipePreparation, setupFailure };
  ownedDirectory(directory, "workspace");
  ownedDirectory(directory, "home");
  ownedDirectory(ownedDirectory(homeDir, ".openclaw-worker"), "manifests");
  ownedDirectory(workspaceDir, ".git");
  if (git(workspaceDir, ["rev-parse", "HEAD"]) !== input.baseCommit) throw new Error("Prepared project setup changed its Git base");
  verifyRecipe(workspaceDir, true);
  const preparedManifestRef = manifest(workspaceDir, input.baseCommit, [sourceManifestRef]);
  const preparedBytes = readManifest(path.join(workerRoot, "manifests", preparedManifestRef.slice(7) + ".json"), preparedManifestRef);
  if (fresh || changed) {
    const completed = new Map([[sourceManifestRef, sourceBytes], [preparedManifestRef, preparedBytes]]);
    for (const [ref, bytes] of completed) fs.writeFileSync(path.join(manifestRoot, ref.slice(7) + ".json"), bytes, { flag: "wx", mode: 0o600 });
    const completionDirectory = ownedDirectory(completionRoot, sourceManifestRef.slice(7), true);
    // Publish this content-addressed pair last. Root B/P artifacts alone cannot
    // turn an interrupted setup into a reusable completed environment.
    fs.writeFileSync(path.join(completionDirectory, preparedManifestRef.slice(7) + ".json"), preparedBytes, { flag: "wx", mode: 0o600 });
  }
  return { workspaceDir, homeDir, sourceManifestRef, preparedManifestRef, recipePreparation, ...(captureSkipped ? { captureSkipped } : {}) };
}`;

/** Setup runs at the final absolute paths, before enrollment or session overlays. */
export function createProjectSetupScript(
  input: {
    namespace: string;
    seedKey: string;
    preparationKey: string;
    cacheKey: string;
    baseCommit: string;
    setupRecipe?: string;
    runSetupScript?: boolean;
    recipe?: EnvironmentRecipe;
    timeoutMs?: number;
    setupEnv?: Record<string, string>;
    verifiedRetained?: PreparedProjectVerification | null;
  },
  inspectOnly = false,
): string {
  const setupEnv =
    input.setupEnv === undefined ? undefined : PreparedSetupEnvironment.parse(input.setupEnv);
  // Inspection also bootstraps Node before its canonical directory checks can run.
  return `set -eu
if [ -n "\${HOME:-}" ] && [ -L "$HOME/.openclaw-worker" ]; then
  echo 'Prepared project directory escaped its owner' >&2
  exit 1
fi
${DEFAULT_NODE_TOOLCHAIN_SETUP_SH}
node <<'PROJECT_SETUP_SCRIPT'
(${PREPARE_PROJECT_WORKSPACE_JS})(${JSON.stringify({ ...input, ...(setupEnv ? { setupEnv } : {}) })}, ${inspectOnly})
  .then((result) => {
    process.stdout.write(JSON.stringify(result ?? null));
  })
  .catch((error) => { console.error(error.message); process.exitCode = 1; });
PROJECT_SETUP_SCRIPT`;
}

/** Binding follows enrollment and capture; lifecycle writes never enter a shared image. */
export async function runWorkerProjectLifecycle(params: {
  recipe: EnvironmentRecipe;
  tunnel: Pick<WorkerTunnelHandle, "runWorkspaceCommand">;
  postCreate: boolean;
  workspaceDir?: string;
  homeDir?: string;
  runSetupCommand?: (
    command: Parameters<NonNullable<WorkerProvider["runSetupCommand"]>>[1],
  ) => Promise<import("../../process/exec.js").SpawnResult | undefined>;
  assertCurrent: () => void;
  signal?: AbortSignal;
}): Promise<void> {
  const phases: LifecycleCommand[] = [];
  if (params.postCreate && params.recipe.postCreate !== undefined) {
    phases.push(params.recipe.postCreate);
  }
  if (params.recipe.postStart !== undefined) {
    phases.push(params.recipe.postStart);
  }
  if (!phases.length) {
    return;
  }
  params.assertCurrent();
  const timeoutMs = 10 * 60_000;
  const createScript = (setupEnv: Record<string, string> = {}) => {
    PreparedSetupEnvironment.parse(setupEnv);
    return `const run = ${RUN_ENVIRONMENT_COMMAND_JS};
const startedAt = performance.now();
(async () => {
  for (const command of ${JSON.stringify(phases)}) {
    await run(command, { workspaceDir: process.cwd(), homeDir: process.env.HOME, env: ${JSON.stringify({ ...params.recipe.env, ...setupEnv })}, settleDescendants: false, timeoutMs: ${timeoutMs} - (performance.now() - startedAt) });
  }
})().catch((error) => { console.error(error.message + (error.outputTail ? ": " + error.outputTail : "")); process.exitCode = 1; });`;
  };
  if (params.runSetupCommand && (!params.workspaceDir || !params.homeDir)) {
    throw new Error("Cloud lifecycle setup requires the owned prepared workspace and HOME paths");
  }
  const providerResult =
    params.runSetupCommand && params.workspaceDir && params.homeDir
      ? await params.runSetupCommand({
          createScript,
          workspaceDir: params.workspaceDir,
          homeDir: params.homeDir,
          timeoutMs,
          assertCurrent: params.assertCurrent,
          signal: params.signal,
        })
      : undefined;
  params.assertCurrent();
  const result =
    providerResult ??
    (await params.tunnel.runWorkspaceCommand({
      argv: ["node", "-e", createScript()],
      transportRetry: "never",
      assertCurrent: params.assertCurrent,
      timeoutMs,
      signal: params.signal,
    }));
  params.assertCurrent();
  if (result.code !== 0) {
    throw new Error(`Cloud environment lifecycle command failed: ${result.stderr || result.code}`);
  }
}
