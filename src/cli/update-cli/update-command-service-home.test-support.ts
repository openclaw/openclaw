import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import * as openClawTmp from "../../infra/tmp-openclaw-dir.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../../infra/update-managed-service-handoff-lease.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";

export async function withServiceHome(run: (home: string) => Promise<void>): Promise<void> {
  await withTestDir({ prefix: "openclaw-update-service-" }, async (home) => {
    const temporary = vi.spyOn(openClawTmp, "resolvePreferredOpenClawTmpDir").mockReturnValue(home);
    try {
      const databasePath = resolveManagedUpdateLeaseDatabasePath();
      expect(databasePath).toBe(path.join(home, "managed-update-handoffs.sqlite"));
      expect(await fs.realpath(path.dirname(databasePath))).toBe(home);
      await withEnvAsync(
        {
          HOME: home,
          USERPROFILE: home,
          APPDATA: path.join(home, "AppData"),
          OPENCLAW_GATEWAY_PORT: undefined,
          OPENCLAW_HOME: undefined,
          OPENCLAW_STATE_DIR: undefined,
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_PROFILE: undefined,
          OPENCLAW_SUPERVISOR_MODE: undefined,
          OPENCLAW_SERVICE_MARKER: undefined,
          OPENCLAW_SERVICE_KIND: undefined,
        },
        () => run(home),
      );
    } finally {
      temporary.mockRestore();
    }
  });
}
