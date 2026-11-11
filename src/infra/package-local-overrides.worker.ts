import process from "node:process";

// Retained dependencies own this operation. Native policy is process-local and
// must be selected before loading the old updater's filesystem implementation.
const [configUrl, rootUrl, durabilityUrl, errorsUrl, rootDir, sourcePath, relativePath] =
  process.argv.slice(2);
if (
  !configUrl ||
  !rootUrl ||
  !durabilityUrl ||
  !errorsUrl ||
  !rootDir ||
  !sourcePath ||
  !relativePath
) {
  throw new Error("Local override publication requires its retained runtime and paths");
}

const { configureFsSafeNative }: typeof import("@openclaw/fs-safe/config") = await import(
  configUrl
);
configureFsSafeNative({ mode: "require" });
const { root }: typeof import("@openclaw/fs-safe/root") = await import(rootUrl);
const { publishFileExclusive }: typeof import("@openclaw/fs-safe/durability") = await import(
  durabilityUrl
);
const { FsSafeError }: typeof import("@openclaw/fs-safe/errors") = await import(errorsUrl);
const packageFs = await root(rootDir, { hardlinks: "reject", symlinks: "reject" });
const source = await packageFs.open(sourcePath);
try {
  // Older retained fs-safe versions implement Root.move as check+rename even
  // in required mode. Publication needs the atomic no-replace primitive.
  await publishFileExclusive({
    sourcePath: source.realPath,
    targetPath: await packageFs.resolve(relativePath),
    expectedSourceIdentity: source.exactIdentity,
    strategy: "rename-noreplace",
  });
  process.stdout.write("moved");
} catch (error) {
  // Publication can succeed before verification or directory sync fails. Retain
  // that receipt so the caller still restores the moved file during rollback.
  if (error instanceof FsSafeError && error.details?.targetCreated === true) {
    process.stdout.write("moved");
  }
  throw error;
} finally {
  await source.handle.close();
}
