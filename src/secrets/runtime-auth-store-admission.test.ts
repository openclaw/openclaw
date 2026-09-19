import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { AuthProfileStoreUnreadableError } from "../agents/auth-profiles/store-unreadable-error.js";
import {
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import {
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

it.each(["matching", "other-state", "other-path"])(
  "isolates an unreadable auth store only with a %s admission refusal",
  async (scope) => {
    const root = tempDirs.make("openclaw-secret-admission-");
    const env = { OPENCLAW_STATE_DIR: root };
    const workerDir = path.join(root, "agents/worker/agent");
    const healthyDir = path.join(root, "agents/main/agent");
    const databasePath = path.join(workerDir, "openclaw-agent.sqlite");
    const refusal = createAgentDatabaseInspectionRefusal({
      agentId: "worker",
      paths: [scope === "other-path" ? path.join(root, "other.sqlite") : databasePath],
      reason: "SQLite reported that this file is not a database.",
    });
    recordAgentDatabaseAdmissions([refusal], {
      env: scope === "other-state" ? { OPENCLAW_STATE_DIR: path.join(root, "other-state") } : env,
      source: "startup",
    });
    const failure = new AuthProfileStoreUnreadableError(databasePath);
    const loadAuthStore = vi.fn((agentDir?: string) => {
      if (agentDir === workerDir) {
        throw failure;
      }
      return loadAuthStoreWithProfiles({
        "custom:healthy": { type: "api_key", provider: "custom", key: "fixture-key" },
      });
    });
    const preparing = prepareSecretsRuntimeSnapshot({
      config: {},
      env,
      agentDirs: [healthyDir, workerDir],
      includeConfigRefs: false,
      allowUnavailableSecretOwners: true,
      loadAuthStore,
    });
    if (scope !== "matching") {
      await expect(preparing).rejects.toBe(failure);
      return;
    }
    const snapshot = await preparing;
    expect(snapshot.authStores.map((entry) => entry.agentDir)).toEqual([healthyDir]);
    expect(snapshot.authStores[0]?.store.profiles["custom:healthy"]).toMatchObject({
      key: "fixture-key",
    });
    expect(loadAuthStore).not.toHaveBeenCalledWith(workerDir);
    expect(snapshot.degradedOwners).toEqual([
      expect.objectContaining({
        ownerKind: "route",
        state: "unavailable",
        degradationState: "cold",
        paths: [databasePath],
        reason: `${refusal.reason}\n${refusal.repairHint}`,
      }),
    ]);
    expect(readAgentDatabaseAdmissionRefusal("worker", { env })).toBe(refusal);
  },
);

it.each(["same-path", "path-alias"])(
  "keeps the healthy owner's credentials when another agent is refused at %s",
  async (locator) => {
    const root = tempDirs.make("openclaw-secret-owner-");
    const env = { OPENCLAW_STATE_DIR: root };
    const agentDir = path.join(root, "agents/main/agent");
    const databasePath = path.join(agentDir, "openclaw-agent.sqlite");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(databasePath, "fixture");
    const alias = path.join(root, "alias.sqlite");
    fs.linkSync(databasePath, alias);
    recordAgentDatabaseAdmissions(
      [
        {
          agentId: "worker",
          paths: [locator === "same-path" ? databasePath : alias],
          code: "agent-database-ownership-mismatch",
          embeddedOwnerId: "main",
          reason: "The worker path belongs to main.",
          repairHint: "Repair the worker database path.",
        },
      ],
      { env, source: "startup" },
    );
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: {},
      env,
      agentDirs: [agentDir],
      includeConfigRefs: false,
      loadAuthStore: () =>
        loadAuthStoreWithProfiles({
          "custom:healthy": { type: "api_key", provider: "custom", key: "fixture-key" },
        }),
    });
    expect(snapshot.authStores[0]?.store.profiles["custom:healthy"]).toMatchObject({
      key: "fixture-key",
    });
    expect(snapshot.degradedOwners).toEqual([]);
  },
);

it("loads a pending agent's auth store under its live preparation authority", async () => {
  const root = tempDirs.make("openclaw-secret-preparation-");
  const env = { OPENCLAW_STATE_DIR: root };
  const agentDir = path.join(root, "agents/worker/agent");
  const refusal = createAgentDatabaseInspectionRefusal({
    agentId: "worker",
    paths: [path.join(agentDir, "openclaw-agent.sqlite")],
    reason: "Inspection is still running.",
    pending: true,
  });
  recordAgentDatabaseAdmissions([refusal], { env, source: "startup" });
  await preparePendingAgentDatabase(refusal, { env, assertCurrent: () => {} }, async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: {},
      env,
      agentDirs: [agentDir],
      includeConfigRefs: false,
      loadAuthStore: () =>
        loadAuthStoreWithProfiles({
          "custom:worker": { type: "api_key", provider: "custom", key: "fixture-key" },
        }),
    });
    expect(snapshot.authStores.map((entry) => entry.agentDir)).toEqual([agentDir]);
    expect(snapshot.degradedOwners).toEqual([]);
  });
});
