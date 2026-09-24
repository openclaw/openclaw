import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import * as bootstrap from "../agents/auth-profiles/shared-store-bootstrap.js";
import {
  resolveAuthProfileDatabasePath,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { migrateSharedAuthStore } from "./state-migrations.shared-auth-store.js";

it("joins pre-existing source resources before returning a migration read failure", async () => {
  const state = await createOpenClawTestState({ prefix: "openclaw-shared-auth-drain-" });
  let unregister: (() => void) | undefined;
  try {
    writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, state.agentDir());
    const sourcePath = resolveAuthProfileDatabasePath(state.agentDir());
    let drained = false;
    unregister = registerOpenClawAgentDatabaseAsyncResource({
      agentId: "main",
      path: sourcePath,
      revoke: () => {},
      close: async () => {
        await setImmediate();
        drained = true;
      },
    });
    vi.spyOn(bootstrap, "readSharedAuthLegacyRowsFromDatabase").mockImplementationOnce(() => {
      throw new Error("source read failed");
    });

    const result = await migrateSharedAuthStore({
      detected: { sourcePath, hasLegacy: true },
      stateDir: state.stateDir,
      env: state.env,
    });

    expect(result.warnings).toEqual([expect.stringContaining("source read failed")]);
    expect(drained).toBe(true);
  } finally {
    vi.restoreAllMocks();
    await closeOpenClawAgentDatabasesAsync();
    unregister?.();
    await state.cleanup();
  }
});
