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
type Options = Parameters<typeof prepareSecretsRuntimeSnapshot>[0];
const credential = { type: "api_key", provider: "custom", key: "fixture-key" } as const;
const healthyStore = () => loadAuthStoreWithProfiles({ "custom:healthy": credential });
const entry = (agentDir: string) => ({
  agentDir,
  store: { profiles: { "custom:healthy": credential } },
});

function fixture(agentId = "worker") {
  const root = tempDirs.make("openclaw-secret-admission-");
  const env = { OPENCLAW_STATE_DIR: root };
  const agentDir = path.join(root, "agents", agentId, "agent");
  const databasePath = path.join(agentDir, "openclaw-agent.sqlite");
  const prepare = (overrides: Partial<Options> = {}) =>
    prepareSecretsRuntimeSnapshot({
      config: {},
      env,
      agentDirs: [agentDir],
      includeConfigRefs: false,
      loadAuthStore: healthyStore,
      ...overrides,
    });
  return { root, env, agentDir, databasePath, prepare };
}

it.each(["matching", "other-state", "other-path"])(
  "isolates an unreadable auth store only with a %s admission refusal",
  async (scope) => {
    const { root, env, agentDir, databasePath, prepare } = fixture();
    const healthyDir = path.join(root, "agents/main/agent");
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
    const loadAuthStore = vi.fn(async (dir?: string) => {
      if (dir === agentDir) {
        throw failure;
      }
      return healthyStore();
    });
    const preparing = prepare({
      agentDirs: [healthyDir, agentDir],
      allowUnavailableSecretOwners: true,
      loadAuthStore,
    });
    if (scope !== "matching") {
      await expect(preparing).rejects.toBe(failure);
      return;
    }
    const snapshot = await preparing;
    expect(snapshot).toMatchObject({
      authStores: [entry(healthyDir)],
      degradedOwners: [
        {
          ownerKind: "route",
          state: "unavailable",
          degradationState: "cold",
          paths: [databasePath],
          reason: `${refusal.reason}\n${refusal.repairHint}`,
        },
      ],
    });
    expect(loadAuthStore).not.toHaveBeenCalledWith(agentDir);
    expect(readAgentDatabaseAdmissionRefusal("worker", { env })).toBe(refusal);
  },
);

it.each(["other-owner", "pending-authority"])(
  "loads healthy credentials under %s admission",
  async (scope) => {
    const agentId = scope === "other-owner" ? "main" : "worker";
    const { env, agentDir, databasePath, prepare } = fixture(agentId);
    if (scope === "other-owner") {
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(databasePath, "fixture");
    }
    const refusal =
      scope === "other-owner"
        ? {
            agentId: "worker",
            paths: [databasePath],
            code: "agent-database-ownership-mismatch" as const,
            embeddedOwnerId: "main",
            reason: "The worker path belongs to main.",
            repairHint: "Repair the worker database path.",
          }
        : createAgentDatabaseInspectionRefusal({
            agentId,
            paths: [databasePath],
            reason: "Inspection is still running.",
            pending: true,
          });
    recordAgentDatabaseAdmissions([refusal], { env, source: "startup" });
    const prepareHealthy = async () => {
      expect(await prepare()).toMatchObject({ authStores: [entry(agentDir)], degradedOwners: [] });
    };
    if (scope === "pending-authority") {
      const loadAuthStore = vi.fn();
      expect(await prepare({ loadAuthStore })).toMatchObject({
        authStores: [],
        degradedOwners: [],
      });
      expect(loadAuthStore).not.toHaveBeenCalled();
      expect(readAgentDatabaseAdmissionRefusal(agentId, { env })).toBe(refusal);
      await preparePendingAgentDatabase(refusal, { env, assertCurrent: () => {} }, prepareHealthy);
      expect(readAgentDatabaseAdmissionRefusal(agentId, { env })).toBeUndefined();
    } else {
      await prepareHealthy();
    }
  },
);
