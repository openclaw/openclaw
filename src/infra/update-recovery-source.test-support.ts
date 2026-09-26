import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { UpdateRecoverySourceAttestation } from "./update-recovery-source-schema.js";

type Resource = UpdateRecoverySourceAttestation["resources"][number];

// Synthetic protocol input for the lower reader/validator. This deliberately does
// not call the production capture or encoder, and grants no original authority.
// Upper's producer tests own capture/publication/retirement acceptance.
export function sourceInventoryFixture(params: {
  runId: string;
  operationId: string;
  resources: { sourcePath: string; sqlite?: boolean }[];
}) {
  function image(file: string): Resource["image"] {
    const stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (!stat) {
      return { kind: "missing" };
    }
    const metadata = {
      identity: `${stat.dev}:${stat.ino}`,
      mode: Number(stat.mode & 0o7777n),
      uid: String(stat.uid),
      gid: String(stat.gid),
      nlink: String(stat.nlink),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs),
      birthtimeNs: String(stat.birthtimeNs),
    };
    if (stat.isSymbolicLink()) {
      return { kind: "symlink", ...metadata, target: fs.readlinkSync(file) };
    }
    if (stat.isDirectory()) {
      return { kind: "directory", ...metadata, children: fs.readdirSync(file).toSorted() };
    }
    return {
      kind: "file",
      ...metadata,
      sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
      size: Number(stat.size),
    };
  }
  const resources: Resource[] = params.resources.map(({ sourcePath, sqlite }) => {
    let ancestor = path.dirname(sourcePath);
    while (!fs.existsSync(ancestor)) {
      ancestor = path.dirname(ancestor);
    }
    const stat = fs.statSync(ancestor, { bigint: true });
    return {
      sourcePath,
      ancestor: { path: ancestor, identity: `${stat.dev}:${stat.ino}` },
      image: image(sourcePath),
      sidecars: sqlite
        ? (["-wal", "-shm", "-journal"] as const).map((suffix) => ({
            suffix,
            image: image(sourcePath + suffix),
          }))
        : [],
    };
  });
  resources.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  return { runId: params.runId, operationId: params.operationId, resources };
}
