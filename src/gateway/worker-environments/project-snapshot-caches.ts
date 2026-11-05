/** Runs only for a claimed disposable image builder, after current project content is verified. */
export const NORMALIZE_PROJECT_SNAPSHOT_CACHES_JS = `(root, input, sourceRef, preparedRef, verifySeed) => {
  const fs = require("node:fs"), path = require("node:path");
  const fail = (cacheCheck, cacheKind) => {
    const error = new Error("Project snapshot cache verification failed");
    error.snapshotDiagnostic = { schema: "openclaw.project-snapshot-diagnostic.v1", cacheCheck, cacheKind };
    throw error;
  };
  const directory = (parent, name, kind) => {
    const target = path.join(parent, name);
    let stat;
    try { stat = fs.lstatSync(target); }
    catch { fail("cache-path", kind); }
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(target) !== target) fail("cache-path", kind);
    return target;
  };
  const namespace = (kind) => {
    const parent = directory(root, kind, kind);
    const names = fs.readdirSync(parent);
    if (names.length !== 1 || names[0] !== input.namespace) fail("cache-inventory", kind);
    return directory(parent, input.namespace, kind);
  };
  const removals = [];
  const seeds = namespace("git-seeds");
  for (const name of fs.readdirSync(seeds)) {
    if (!/^[a-f0-9]{64}$/.test(name)) fail("unapproved-entry", "git-seeds");
    const seed = directory(seeds, name, "git-seeds");
    if (name !== input.seedKey) removals.push(seed);
  }
  const selectedSeed = directory(seeds, input.seedKey, "git-seeds");
  try { verifySeed(selectedSeed); } catch { fail("verification", "git-seeds"); }
  const prepared = namespace("prepared");
  const names = fs.readdirSync(prepared);
  if (names.length !== 1 || names[0] !== input.cacheKey) fail("cache-inventory", "prepared");
  const current = directory(prepared, input.cacheKey, "prepared");
  if (fs.readdirSync(current).sort().join("\\0") !== "home\\0workspace") fail("unapproved-entry", "prepared");
  const manifests = directory(root, "manifests", "manifests");
  const retained = new Set([sourceRef, preparedRef].map((ref) => ref.slice(7) + ".json"));
  for (const name of fs.readdirSync(manifests)) {
    if (!/^[a-f0-9]{64}[.]json$/.test(name)) fail("unapproved-entry", "manifests");
    const file = path.join(manifests, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(file) !== file) fail("cache-path", "manifests");
    if (!retained.has(name)) removals.push(file);
  }
  // Validate the entire plan before removing anything; obsolete owned content needs no rescan.
  for (const target of removals) fs.rmSync(target, { recursive: true });
}`;
