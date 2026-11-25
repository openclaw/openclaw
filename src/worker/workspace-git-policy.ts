import {
  gitMaintenanceEnvironment,
  gitMaintenanceEnvironmentExpression,
} from "../infra/git-maintenance-env.js";

/** Shared by portable worker programs that must not execute repository configuration. */
export const WORKER_STANDALONE_GIT_VIEW_JS = String.raw`
function createWorkerGitView(workspaceRoot, admittedBase, viewParent, origin) {
  const gitFs = require("node:fs");
  const gitPath = require("node:path");
  const gitDir = gitPath.join(workspaceRoot, ".git");
  const kind = (name) => {
    const stat = gitFs.lstatSync(gitPath.join(gitDir, name), {throwIfNoEntry:false});
    return !stat ? "missing" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
  };
  const standalone = kind(".") === "directory" && kind("objects") === "directory" && kind("refs") === "directory" &&
    kind("HEAD") === "file" && ["commondir", "objects/info/alternates", "objects/info/http-alternates"].every((name) => kind(name) === "missing") &&
    ["objects/pack", "objects/info", "reftable"].every((name) => kind(name) !== "file" && kind(name) !== "other") &&
    ["packed-refs", "shallow"].every((name) => kind(name) !== "directory" && kind(name) !== "other");
  if (!standalone) return undefined;
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(admittedBase)) throw new Error("Invalid admitted Git base");
  const sha256 = admittedBase.length === 64;
  const reftable = kind("reftable") === "directory";
  const nil = process.platform === "win32" ? "NUL" : "/dev/null";
  const view = gitFs.mkdtempSync(gitPath.join(viewParent, "git-view-"));
  const close = () => gitFs.rmSync(view, {recursive:true, force:true});
  try {
    for (const name of ["objects", "refs", "reftable"]) {
      if (kind(name) === "directory") gitFs.symlinkSync(gitPath.join(gitDir, name), gitPath.join(view, name), process.platform === "win32" ? "junction" : "dir");
    }
    for (const name of ["packed-refs", "shallow"]) {
      if (kind(name) === "file") gitFs.copyFileSync(gitPath.join(gitDir, name), gitPath.join(view, name));
    }
    gitFs.writeFileSync(gitPath.join(view, "config"), "[core]\n\trepositoryformatversion = " + (sha256 || reftable || origin ? 1 : 0) +
      "\n\tbare = false\n\tlongpaths = true\n\thooksPath = " + JSON.stringify(nil) + "\n\tfsmonitor = false\n[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n[protocol]\n\tallow = never\n[credential]\n\thelper =\n[http]\n\tfollowRedirects = false\n[extensions]\n" +
      (sha256 ? "\tobjectFormat = sha256\n" : "") + (reftable ? "\trefStorage = reftable\n" : "") +
      (origin ? "\tpartialClone = origin\n[remote \"origin\"]\n\turl = " + JSON.stringify(origin) + "\n\tpromisor = true\n\tpartialclonefilter = blob:none\n" : ""));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
    Object.assign(env, {
      GIT_DIR: gitDir, GIT_COMMON_DIR: view, GIT_WORK_TREE: workspaceRoot,
      GIT_CONFIG_GLOBAL: nil, GIT_CONFIG_SYSTEM: nil, GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1",
      GIT_ALLOW_PROTOCOL: "", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
      ...(origin ? {GIT_SHALLOW_FILE: gitPath.join(gitDir, "shallow")} : {}),
    });
    return {env, close};
  } catch (error) { close(); throw error; }
}
`;

/** Refreshing an active checkout must never lend its mutable config the GitHub credential. */
export const AUTHENTICATED_REF_REFRESH_JS = String.raw`const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { origin, token, baseCommit } = JSON.parse(fs.readFileSync(0, "utf8"));
const url = new URL(origin);
if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Repository ref refresh requires its admitted HTTPS origin");
${WORKER_STANDALONE_GIT_VIEW_JS}
const view = createWorkerGitView(process.cwd(), baseCommit, os.tmpdir(), origin);
if (!view) throw new Error("Repository ref refresh requires a standalone checkout");
try {
  const env = view.env;
  delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
  env.GIT_ALLOW_PROTOCOL = "https";
  Object.assign(env, token ? ${gitMaintenanceEnvironmentExpression([
    [
      '"http." + origin + ".extraheader"',
      '"Authorization: Basic " + Buffer.from("x-access-token:" + token).toString("base64")',
    ],
  ])} : ${JSON.stringify(gitMaintenanceEnvironment())});
  const result = spawnSync("git", ["fetch", "--no-tags", "--no-auto-maintenance", "--no-write-fetch-head",
    "--no-recurse-submodules", "--", origin, "+refs/heads/main:refs/remotes/origin/main"],
    { env, stdio: ["ignore", "inherit", "inherit"] });
  if (result.error) console.error((result.error.code ? result.error.code + ": " : "") + result.error.message);
  process.exitCode = result.status ?? 1;
} finally { view.close(); }`;
