import {
  WORKER_BUNDLE_ARTIFACT_PATHS,
  WORKER_BUNDLE_CHUNK_PATH_PATTERN,
  WORKER_BUNDLE_MANIFEST_VERSION,
} from "../../shared/worker-bundle-hash.js";
import { DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS } from "../../shared/worker-bundle-limits.js";

export const RECEIPT_MATCH_JS = String.raw`const fs = require("node:fs");
try {
  let actual;
  if (process.argv[3] === "inspect") {
    const fd = fs.openSync(process.argv[1], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32768) throw new Error("unsafe worker receipt");
      actual = JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally { fs.closeSync(fd); }
  } else actual = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const expected = JSON.parse(process.argv[2]);
  const shapeMatches =
    Object.keys(actual).sort().join(",") === "bundleHash,openclawVersion,protocolFeatures";
  const featuresMatch =
    Array.isArray(actual.protocolFeatures) &&
    Array.isArray(expected.protocolFeatures) &&
    actual.protocolFeatures.length === expected.protocolFeatures.length &&
    actual.protocolFeatures.every((feature, index) => feature === expected.protocolFeatures[index]);
  process.exitCode =
    shapeMatches &&
      actual.bundleHash === expected.bundleHash &&
      actual.openclawVersion === expected.openclawVersion &&
      featuresMatch
      ? 0
      : 1;
} catch {
  process.exitCode = 1;
}`;

const WORKER_ARTIFACT_PATHS_JS = `const artifactPaths = ${JSON.stringify(WORKER_BUNDLE_ARTIFACT_PATHS)};
const chunkPathPattern = ${WORKER_BUNDLE_CHUNK_PATH_PATTERN.toString()};`;

// Recompute the gateway's canonical flat file manifest before a receipt can attest to it.
export const VERIFY_INSTALL_JS = String.raw`const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[1];
const expected = process.argv[2];
const install = process.argv[3];
const inspectOnly = process.argv[4] === "inspect";
${WORKER_ARTIFACT_PATHS_JS}
const entries = [];
let totalBytes = 0;
function fail(message) {
  throw new Error(message);
}
function assertRoot() {
  const stats = fs.lstatSync(root);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail("unsafe worker install root");
  }
  if (!inspectOnly) fs.chmodSync(root, 0o700);
}
function addFile(relative) {
  const absolute = path.join(root, relative);
  const stats = fs.lstatSync(absolute);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    fail("unsafe worker file: " + relative);
  }
  if (inspectOnly) {
    totalBytes += stats.size;
    if (totalBytes > ${DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS.maxExpandedBytes} || entries.length >= ${DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS.maxEntries}) fail("worker bundle inspection exceeds its limit");
  }
  const contents = fs.readFileSync(absolute);
  const mode = inspectOnly ? stats.mode & 0o777 : 0o700;
  if (!inspectOnly) fs.chmodSync(absolute, mode);
  entries.push({
    path: relative,
    mode,
    size: contents.byteLength,
    sha256: crypto.createHash("sha256").update(contents).digest("hex"),
  });
}
try {
  assertRoot();
  if (install === "bundle" || install === "npm") {
    const allowedPaths = new Set([...artifactPaths, "bootstrap-receipt.json"]);
    for (const name of fs.readdirSync(root)) {
      if (chunkPathPattern.test(name)) {
        artifactPaths.push(name);
      } else if (!allowedPaths.has(name)) {
        fail("unexpected worker bundle path: " + name);
      }
    }
    for (const artifactPath of artifactPaths) addFile(artifactPath);
  } else {
    fail("invalid worker install channel");
  }
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const separator = String.fromCharCode(0);
  const hash = crypto.createHash("sha256");
  hash.update("${WORKER_BUNDLE_MANIFEST_VERSION}" + separator);
  for (const entry of entries) {
    hash.update(entry.path + separator + entry.mode.toString(8) + separator + entry.size + separator + entry.sha256 + separator);
  }
  process.exitCode = hash.digest("hex") === expected ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}`;
