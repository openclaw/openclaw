// Frozen launcher code: only Node built-ins, no database or release dependency.
export const MANIFEST_RESTORE_SOURCE = String.raw`
function invalidRestore(file) {
  return new Error("Invalid update restore manifest " + file + ". Preserve it and run openclaw triage before retrying.");
}
function readRestoreManifest(trial, replay) {
  const file = path.join(path.dirname(linked(trial.target)), ".restore");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw invalidRestore(file);
  }
  if (!manifest || manifest.v !== 1 || typeof manifest.runId !== "string" || !manifest.runId || !Array.isArray(manifest.files)) {
    throw invalidRestore(file);
  }
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.live !== "string" || !path.isAbsolute(entry.live) || seen.has(entry.live) ||
        (entry.preimage !== null && (typeof entry.preimage !== "string" || !path.isAbsolute(entry.preimage)))) {
      throw invalidRestore(file);
    }
    seen.add(entry.live);
    if (!replay && entry.preimage !== null) {
      const image = fs.lstatSync(entry.preimage, { throwIfNoEntry: false });
      if (!image?.isFile() && !image?.isSymbolicLink()) throw invalidRestore(file);
    }
  }
  return manifest.files;
}
function restoreManifestFiles(files) {
  // Sidecars must be removed before a database image is restored, regardless of entry order.
  for (const entry of files) {
    if (entry.preimage === null) fs.rmSync(entry.live, { force: true });
  }
  for (const entry of files) {
    if (entry.preimage === null) continue;
    if (fs.lstatSync(entry.preimage, { throwIfNoEntry: false })) {
      fs.renameSync(entry.preimage, entry.live);
    } else if (!fs.lstatSync(entry.live, { throwIfNoEntry: false })) {
      throw new Error("Update restore lost both " + entry.live + " and " + entry.preimage + ". Preserve the manifest and run openclaw triage.");
    }
  }
}
`;
