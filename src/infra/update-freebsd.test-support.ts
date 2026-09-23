import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";

export const nativeFreeBsd = process.platform === "freebsd";

export async function withFreeBsdFixture(
  operation: (fixture: { home: string; root: string; env: NodeJS.ProcessEnv }) => Promise<void>,
  parent = os.tmpdir(),
): Promise<void> {
  if (!nativeFreeBsd) {
    throw new Error("This fixture requires native FreeBSD.");
  }
  // The actual invoking account owns only this private fixture subtree.
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
