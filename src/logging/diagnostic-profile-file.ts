import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";
import { ProfileFailure } from "./diagnostic-profile.js";

/** Successful operator artifacts are retained until manually removed. */
export async function reserveDiagnosticProfileFile(
  kind: "cpu" | "heap",
  assertActive: () => void,
  requiredBytes = 0,
) {
  const directory = path.join(resolveStateDir(), "diagnostics");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (requiredBytes > 0) {
    const space = await fs.statfs(directory);
    if (space.bavail * space.bsize < requiredBytes) {
      throw new ProfileFailure("insufficient-disk-space");
    }
  }
  assertActive();
  const filename = path.join(
    directory,
    `${kind}-${new Date().toISOString().replaceAll(":", "-")}.${kind === "cpu" ? "cpuprofile" : "heapsnapshot"}`,
  );
  return { path: filename, handle: await fs.open(filename, "wx", 0o600) };
}
