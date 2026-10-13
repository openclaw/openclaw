import { NODE_TOOLCHAIN_INSTALL_SH } from "./node-toolchain.js";
import { resolveRepositoryNodeRequirement } from "./repository-node-requirement.js";

/** Runs inside the supported bootstrap Node, before any repository setup command. */
export const PREPARE_REPOSITORY_NODE_JS = `async (workspaceDir, homeDir, machineHome) => {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) return;
  const fs = require("node:fs");
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");
  const files = {};
  for (const name of [".nvmrc", ".node-version", ".tool-versions", "mise.toml", "package.json"]) {
    const file = path.join(workspaceDir, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 1048576) throw new Error("Repository Node declaration must be a regular file under 1 MiB: " + name);
      files[name] = fs.readFileSync(file, "utf8");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const requirement = (${resolveRepositoryNodeRequirement.toString()})(files);
  const manifest = files["package.json"] ? JSON.parse(files["package.json"]) : {};
  let nodeBin = path.dirname(process.execPath);
  const fetchText = async (url) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120000), redirect: "error" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      return await response.text();
    } catch (error) { throw new Error("Repository Node release download failed; allow HTTPS access to nodejs.org and retry preparation (" + error.message + ")"); }
  };
  if (requirement && requirement !== "system") {
    const npm = spawnSync("sh", ["-c", "command -v npm"], { encoding: "utf8" });
    if (npm.status !== 0) throw new Error("Repository Node resolution requires npm beside bootstrap Node; repair the image or profile setup and retry");
    const semver = require(require.resolve("semver", { paths: [path.dirname(fs.realpathSync(npm.stdout.trim()))] }));
    const releases = JSON.parse(await fetchText("https://nodejs.org/dist/index.json"));
    let candidates = releases.filter((release) => release.files.includes("linux-" + process.arch) && semver.valid(release.version));
    if (requirement === "node" || requirement === "latest") {}
    else if (/^lts\\//i.test(requirement)) {
      const lts = requirement.slice(4);
      candidates = candidates.filter((release) => release.lts && (lts === "*" || release.lts.toLowerCase() === lts.toLowerCase()));
    } else {
      const range = semver.validRange(requirement);
      if (!range) throw new Error("Unsupported repository Node requirement " + requirement + "; use a release, major version, or SemVer range");
      candidates = candidates.filter((release) => semver.satisfies(release.version, range));
    }
    candidates.sort((a, b) => semver.rcompare(a.version, b.version));
    const version = candidates[0]?.version.slice(1);
    if (!version) throw new Error("No official Linux Node.js release matches " + requirement + "; fix the repository Node declaration and retry");
    const filename = "node-v" + version + "-linux-" + process.arch + ".tar.gz";
    const sums = await fetchText("https://nodejs.org/dist/v" + version + "/SHASUMS256.txt");
    const digest = sums.split("\\n").map((line) => line.trim().split(/\\s+/)).find((entry) => entry[1] === filename)?.[0];
    if (!digest || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("Node.js release SHA-256 is missing; check nodejs.org connectivity and retry preparation");
    const installed = spawnSync("sh", ["-s", "--", version, digest], {
      input: ${JSON.stringify(`${NODE_TOOLCHAIN_INSTALL_SH}\nopenclaw_install_node "$1" "$2"\n`)},
      env: { PATH: process.env.PATH, HOME: machineHome }, encoding: "utf8", timeout: 660000,
    });
    if (installed.status !== 0) throw new Error("Repository Node installation failed; check nodejs.org access, disk space and image prerequisites, then retry: " + (installed.stderr || installed.error?.message || installed.status));
    nodeBin = installed.stdout.trim();
  }
  const bin = path.join(homeDir, ".local", "bin");
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  for (const name of ["node", "npm", "npx", "corepack"]) {
    let target = path.join(nodeBin, name);
    if (name === "corepack" && !fs.existsSync(target)) {
      const corepack = spawnSync("sh", ["-c", "command -v corepack"], { encoding: "utf8" });
      if (corepack.status === 0) target = corepack.stdout.trim();
    }
    if (!fs.existsSync(target)) continue;
    const link = path.join(bin, name);
    try { fs.unlinkSync(link); } catch (error) { if (error.code !== "ENOENT") throw error; }
    fs.symlinkSync(target, link);
  }
  const setupPath = bin + path.delimiter + process.env.PATH;
  if (typeof manifest.packageManager === "string" && manifest.packageManager.trim()) {
    const enabled = spawnSync(path.join(bin, "corepack"), ["enable", "--install-directory", bin], {
      env: { PATH: setupPath, HOME: homeDir }, encoding: "utf8", timeout: 60000,
    });
    if (enabled.status !== 0) throw new Error("Corepack enable failed; supply Corepack in the image or profile setup and retry preparation: " + (enabled.stderr || enabled.error?.message || enabled.status));
  }
  return setupPath;
}`;
