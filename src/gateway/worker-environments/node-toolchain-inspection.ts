import {
  MAX_WORKSPACE_INVENTORY_ENTRIES,
  MAX_WORKSPACE_INVENTORY_TOTAL_BYTES,
} from "./workspace-inventory-limits.js";

/** Runs in the preparation owner's worker process; Factory never reads installer metadata. */
export const INSPECT_NODE_TOOLCHAIN_JS = `async (machineHome, expected) => {
  const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
  const { spawnSync } = require("node:child_process");
  const { pipeline } = require("node:stream/promises");
  let failureReason = "cache-io";
  const fail = (reason = "identity") => { failureReason = reason; throw new Error("Repository Node toolchain cache is not completely verified"); };
  try {
  if (!expected || !/^(0|[1-9][0-9]{0,5})[.](0|[1-9][0-9]{0,5})[.](0|[1-9][0-9]{0,5})$/.test(expected.version) ||
      expected.platform !== "linux" || process.platform !== "linux" || expected.arch !== process.arch || !["x64", "arm64"].includes(expected.arch) ||
      !/^[a-f0-9]{64}$/.test(expected.archiveSha256)) fail();
  const keys = Object.keys(expected).sort().join(",");
  if (keys !== "arch,archiveSha256,platform,version" && keys !== "arch,archiveSha256,inventorySha256,platform,version") fail();
  if (expected.inventorySha256 !== undefined && !/^[a-f0-9]{64}$/.test(expected.inventorySha256)) fail();
  let root = machineHome;
  for (const part of [".openclaw-worker", "toolchains", "node", expected.version + "-linux-" + expected.arch + "-" + expected.archiveSha256]) {
    root = path.join(root, part);
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || fs.realpathSync(root) !== root || (stat.mode & 0o022)) fail();
  }
  const archive = path.join(root, ".archive.tgz");
  const regular = (file) => {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(file) !== file ||
        stat.size > ${MAX_WORKSPACE_INVENTORY_TOTAL_BYTES} || (stat.mode & 0o7022)) fail();
    return stat;
  };
  const digest = async (file) => {
    regular(file);
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest("hex");
  };
  if (await digest(archive) !== expected.archiveSha256) fail();
  const npm = spawnSync("sh", ["-c", "command -v npm"], { encoding: "utf8" });
  if (npm.status !== 0) fail();
  const tar = require(require.resolve("tar", { paths: [path.dirname(fs.realpathSync(npm.stdout.trim()))] }));
  const prefix = "node-v" + expected.version + "-linux-" + expected.arch;
  const entries = new Map();
  let expanded = 0;
  const parser = tar.list({ strict: true, onReadEntry(entry) {
    try {
      const name = entry.path.replace(/\\/$/, "");
      if (name === prefix && entry.type === "Directory") { entry.resume(); return; }
      if (!name.startsWith(prefix + "/")) fail("archive-root");
      const relative = name.slice(prefix.length + 1);
      if (!relative || relative.includes("\\\\") || path.posix.normalize(relative) !== relative ||
          relative === ".." || relative.startsWith("../") || entries.has(relative) ||
          [".files.sha256", ".archive.tgz"].includes(relative) || entries.size >= ${MAX_WORKSPACE_INVENTORY_ENTRIES}) fail("archive-path");
      if (!["File", "Directory", "SymbolicLink"].includes(entry.type)) fail("archive-type");
      expanded += entry.size;
      if (!Number.isSafeInteger(expanded) || expanded > ${MAX_WORKSPACE_INVENTORY_TOTAL_BYTES}) fail("archive-budget");
      const value = { type: entry.type, mode: entry.mode, size: entry.size, target: entry.linkpath };
      entries.set(relative, value);
      if (entry.type === "SymbolicLink") {
        const target = entry.linkpath;
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), target));
        if (path.posix.isAbsolute(target) || target.includes("\\\\") || resolved === ".." || resolved.startsWith("../")) fail("archive-link");
      }
      const hash = crypto.createHash("sha256");
      entry.on("data", chunk => hash.update(chunk));
      entry.on("end", () => { value.sha256 = hash.digest("hex"); });
      entry.resume();
    } catch (error) { parser.abort(error); }
  } });
  await pipeline(fs.createReadStream(archive), parser);
  const inventory = [];
  const files = new Map();
  const visit = async (directory, parent = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = parent ? parent + "/" + entry.name : entry.name;
      if (!parent && [".files.sha256", ".archive.tgz"].includes(entry.name)) continue;
      const wanted = entries.get(relative);
      if (!wanted) fail();
      const file = path.join(directory, entry.name), stat = fs.lstatSync(file);
      if (wanted.type === "Directory") {
        if (!stat.isDirectory() || fs.realpathSync(file) !== file || (stat.mode & 0o7022)) fail();
        inventory.push({ path: relative, type: "directory", mode: stat.mode & 0o777 });
        await visit(file, relative);
      } else if (wanted.type === "SymbolicLink") {
        if (!stat.isSymbolicLink() || fs.readlinkSync(file) !== wanted.target || !fs.realpathSync(file).startsWith(root + path.sep)) fail();
        inventory.push({ path: relative, type: "symlink", target: wanted.target });
      } else {
        regular(file);
        const sha256 = await digest(file);
        if (stat.size !== wanted.size || sha256 !== wanted.sha256 || (stat.mode & 0o100) !== (wanted.mode & 0o100)) fail();
        files.set("./" + relative, sha256);
        inventory.push({ path: relative, type: "file", mode: stat.mode & 0o777, size: stat.size, sha256 });
      }
    }
  };
  await visit(root);
  if (inventory.length !== entries.size) fail();
  const metadata = path.join(root, ".files.sha256");
  regular(metadata);
  if (fs.statSync(metadata).size > 64 * 1024 * 1024) fail();
  const lines = fs.readFileSync(metadata, "utf8").trimEnd().split("\\n");
  const seen = new Set();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match || seen.has(match[2]) || files.get(match[2]) !== match[1]) fail();
    seen.add(match[2]);
  }
  if (seen.size !== files.size) fail();
  inventory.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const inventorySha256 = crypto.createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
  if (expected.inventorySha256 && expected.inventorySha256 !== inventorySha256) fail();
  return { version: expected.version, platform: "linux", arch: expected.arch, archiveSha256: expected.archiveSha256, inventorySha256 };
  } catch {
    throw new Error("Repository Node toolchain cache is not completely verified (" + failureReason + ")");
  }
}`;
