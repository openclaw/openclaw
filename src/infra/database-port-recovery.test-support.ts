import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabasePortManifest } from "./database-port-recovery.js";

export function makeDatabasePortManifest(stateDir: string): DatabasePortManifest {
  const root = fs.lstatSync(stateDir, { bigint: true });
  const originalPath = path.join(stateDir, "workboard.sqlite");
  const sha256 = "a".repeat(64);
  return {
    version: 1,
    operationId: randomUUID(),
    revision: 1,
    state: "preparing",
    root: { stateDir, dev: String(root.dev), ino: String(root.ino) },
    direction: { from: "sqlite", to: "postgres" },
    originalConfig: [{ path: path.join(stateDir, "openclaw.json"), sha256, size: 2 }],
    artifacts: [],
    targets: [
      {
        storeId: randomUUID(),
        sourceSchemaVersion: 1,
        targetSchemaVersion: 1,
        descriptorHash: sha256,
        original: { engine: "sqlite", path: originalPath },
        intended: { engine: "postgres", anchorPath: originalPath, namespace: "port_test" },
        originalCapture: { path: path.join(stateDir, "original.sqlite"), sha256, size: 1 },
        verification: null,
      },
    ],
  };
}
