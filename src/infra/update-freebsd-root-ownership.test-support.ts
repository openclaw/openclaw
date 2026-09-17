import fs from "node:fs/promises";
import path from "node:path";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";

export const nativeFreeBsdRoot =
  process.platform === "freebsd" && process.getuid?.() === 0 && process.geteuid?.() === 0;

export const freeBsdRootOwnershipEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "update-freebsd-root-ownership",
  distWorkerPath: "infra/update-freebsd-root-ownership.js",
} as const;

export async function withFreeBsdRootFixture(
  operation: (fixture: { home: string; root: string; env: NodeJS.ProcessEnv }) => Promise<void>,
  parent = "/root",
): Promise<void> {
  if (!nativeFreeBsdRoot) {
    throw new Error("This fixture requires native FreeBSD with real and effective root identity.");
  }
  // /tmp's writable ancestor must be rejected by the actual admission contract.
  // Only this private, fixture-owned subtree is created or removed.
  const home = await fs.mkdtemp(path.join(parent, "openclaw-update-admission-"));
  try {
    const root = path.join(home, "installation");
    await fs.mkdir(root, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      OPENCLAW_STATE_DIR: path.join(home, "state-root"),
      OPENCLAW_CONFIG_PATH: path.join(home, "openclaw.json"),
    };
    await operation({ home, root, env });
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(home, { recursive: true, force: true });
  }
}
