import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withEnvAsync } from "../test-utils/env.js";

export async function withChannelSecurityStateDir(fn: (tmp: string) => Promise<void>) {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-security-audit-channel-"));
  const stateDir = path.join(fixtureRoot, "state");
  const credentialsDir = path.join(stateDir, "credentials");
  await fs.mkdir(credentialsDir, {
    recursive: true,
    mode: 0o700,
  });
  try {
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () => fn(stateDir));
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
