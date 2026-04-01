import { readConfigFileSnapshot } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { writeRuntimeJson } from "../runtime.js";

export async function configExplainCommand(
  opts: { json?: boolean } = {},
  runtime: RuntimeEnv,
): Promise<void> {
  const snapshot = await readConfigFileSnapshot();
  const provenance = snapshot.provenance ?? { entries: [], keySources: [] };

  if (opts.json) {
    writeRuntimeJson(
      runtime,
      {
        path: snapshot.path,
        exists: snapshot.exists,
        valid: snapshot.valid,
        provenance,
      },
      0,
    );
    return;
  }

  runtime.log("Config explain");
  runtime.log(`  Path: ${snapshot.path}`);
  runtime.log(`  Exists: ${snapshot.exists ? "yes" : "no"}`);
  runtime.log(`  Valid: ${snapshot.valid ? "yes" : "no"}`);

  if (provenance.entries.length > 0) {
    runtime.log("");
    runtime.log("Loaded entries:");
    for (const entry of provenance.entries) {
      runtime.log(
        `  - [${entry.kind}] ${entry.path}${entry.applied ? "" : " (not found)"}`,
      );
    }
  }

  if (provenance.keySources.length > 0) {
    runtime.log("");
    runtime.log("Tracked key sources:");
    for (const key of provenance.keySources) {
      runtime.log(
        `  - ${key.keyPath}: ${key.sourceKind}${key.sourcePath ? ` (${key.sourcePath})` : ""}`,
      );
    }
  }
}
