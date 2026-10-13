import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import * as bootstrap from "../agents/auth-profiles/shared-store-bootstrap.js";
import {
  loadPersistedAuthProfileStoreFromRows,
  prepareAgentAuthProfileRowsRead,
  readSharedAuthProfileRows,
} from "../agents/auth-profiles/sqlite-read.js";
import {
  resolveAuthProfileDatabasePath,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { captureAuthProfileCredentialAuthority } from "../state/user-model-account-authority.js";
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

it("revokes the source credential authority before relocation and cold-loads the shared credential", async () => {
  const state = await createOpenClawTestState({ prefix: "openclaw-shared-auth-authority-" });
  const credential = { type: "api_key" as const, provider: "openai", key: "relocated-key" };
  try {
    writePersistedAuthProfileStoreRaw(
      { version: 1, profiles: { "openai:default": credential } },
      state.agentDir(),
    );
    const sourcePath = resolveAuthProfileDatabasePath(state.agentDir());
    const reader = prepareAgentAuthProfileRowsRead({
      databasePath: sourcePath,
      agentId: "main",
      env: state.env,
    });
    const authority = reader.captureCredentialAuthority("openai:default")!;
    authority.observe(credential);
    await reader.dispose();
    let deniedBeforeSourceRelease = false;
    const unregister = registerOpenClawAgentDatabaseAsyncResource({
      agentId: "main",
      path: sourcePath,
      revoke: () => {},
      close: async () => {
        try {
          authority.readCurrentCredential();
        } catch {
          deniedBeforeSourceRelease = true;
        }
      },
    });
    try {
      const result = await migrateSharedAuthStore({
        detected: { sourcePath, hasLegacy: true },
        stateDir: state.stateDir,
        env: state.env,
      });
      expect(result.warnings).toEqual([]);
      expect(deniedBeforeSourceRelease).toBe(true);
      expect(() => authority.readCurrentCredential()).toThrow();
      const context = captureOpenClawStateWorkerContext({ env: state.env });
      const identity = `${context.admission.identity.key}:${context.admission.identity.birthtime ?? ""}`;
      const current = captureAuthProfileCredentialAuthority(
        context,
        { identity, databasePath: context.admission.databasePath },
        "openai:default",
      );
      const rows = await readSharedAuthProfileRows(context);
      current.observe(
        loadPersistedAuthProfileStoreFromRows(rows, context.admission.databasePath)?.profiles[
          "openai:default"
        ],
      );
      expect(current.readCurrentCredential()).toEqual(credential);
    } finally {
      unregister();
    }
  } finally {
    await closeOpenClawAgentDatabasesAsync();
    await state.cleanup();
  }
});
