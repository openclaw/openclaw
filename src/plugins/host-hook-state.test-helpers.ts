import fs from "node:fs/promises";
import path from "node:path";
import { withTempConfig } from "../gateway/test-temp-config.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";

type HostHookStateFixture = {
  stateDir: string;
  storePath: string;
  tempConfig: { session: { store: string } } & Record<string, unknown>;
};

export async function withHostHookState(
  prefix: string,
  run: (fixture: HostHookStateFixture) => Promise<void>,
  createTempConfig: (storePath: string) => HostHookStateFixture["tempConfig"] = (storePath) => ({
    agents: { entries: { main: { default: true } } },
    session: { store: storePath },
  }),
): Promise<void> {
  const stateDir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), prefix));
  const storePath = path.join(stateDir, "sessions.json");
  const tempConfig = createTempConfig(storePath);
  try {
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await withTempConfig({
        cfg: tempConfig,
        run: async () => await run({ stateDir, storePath, tempConfig }),
      });
    });
  } finally {
    await cleanupSessionStateForTest({ stateDir });
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}
