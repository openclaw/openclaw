import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  evaluateAgentDatabaseAdmissions,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "./agent-database-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { assertOpenClawDatabasesReady } from "./openclaw-database-preflight.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

describe("agent database admission", () => {
  it.each(["secondary", "registered secondary", "default", "system"] as const)(
    "isolates a divergent %s agent database at startup",
    async (role) => {
      const stateDir = tempDirs.make("openclaw-divergent-admission-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const config: OpenClawConfig = {
        agents: {
          entries: {
            main: { default: role !== "default" },
            cleaner: {
              default: role === "default",
              sandbox: { mode: "all", workspaceAccess: "none", scope: "session" },
            },
          },
          ...(role === "system" ? { defaults: { systemAgent: { agentId: "cleaner" } } } : {}),
        },
      };
      const source = openOpenClawAgentDatabase({ agentId: "main", env }).path;
      if (role === "registered secondary") {
        openOpenClawAgentDatabase({ agentId: "cleaner", env });
      }
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      const target = path.join(stateDir, "agents", "cleaner", "agent", "openclaw-agent.sqlite");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(
        source,
        target,
        role === "registered secondary" ? 0 : fs.constants.COPYFILE_EXCL,
      );
      const { DatabaseSync } = requireNodeSqlite();
      const database = new DatabaseSync(target);
      try {
        database.prepare("UPDATE schema_meta SET app_version = ?").run("divergent-fixture");
      } finally {
        database.close();
      }
      const copyBytes = fs.readFileSync(target);
      const startup = () =>
        assertOpenClawDatabasesReady({ env, operation: "gateway-startup", config });
      if (role === "default" || role === "system") {
        await expect(startup()).rejects.toThrow("belongs to agent main; requested agent cleaner");
        expect(fs.readFileSync(target)).toEqual(copyBytes);
        return;
      }
      await expect(startup()).resolves.toBeUndefined();
      const refusal = readAgentDatabaseAdmissionRefusal("cleaner", { env });
      expect(refusal).toMatchObject({
        agentId: "cleaner",
        paths: [target],
        embeddedOwnerId: "main",
        code: "agent-database-ownership-mismatch",
        repairHint: expect.stringContaining("quarantine move"),
      });
      expect(readAgentDatabaseAdmissionRefusal("main", { env })).toBeUndefined();
      const { prepareSecretsRuntimeSnapshot } = await import("../secrets/runtime.js");
      await expect(
        prepareSecretsRuntimeSnapshot({
          config,
          env,
          includeConfigRefs: false,
          loadablePluginOrigins: new Map(),
        }),
      ).resolves.toBeDefined();
      const { resolveRequestedSessionAgentId } =
        await import("../gateway/session-request-agent.js");
      const { listGatewayAgentsBasic } = await import("../gateway/agent-list.js");
      expect(resolveRequestedSessionAgentId(config, "agent:main:main")).toEqual({
        ok: true,
        agentId: "main",
      });
      expect(resolveRequestedSessionAgentId(config, "agent:cleaner:main")).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", details: refusal },
      });
      expect(
        listGatewayAgentsBasic(config).agents.find((agent) => agent.id === "cleaner"),
      ).toMatchObject({
        status: "degraded",
        admissionRefusal: refusal,
      });
      const { runStartupSessionMigration } =
        await import("../gateway/server-startup-session-migration.js");
      const { assertConfiguredWorkspaceStateReady } =
        await import("../agents/workspace-state-dirs.js");
      await assertConfiguredWorkspaceStateReady({ cfg: config, env });
      await runStartupSessionMigration({ cfg: config, env, log: { info: vi.fn(), warn: vi.fn() } });
      expect(fs.readFileSync(target)).toEqual(copyBytes);
      expect(() => openOpenClawAgentDatabase({ agentId: "cleaner", env })).toThrow(refusal?.reason);
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      fs.renameSync(target, `${target}.operator-backup`);
      const freshDiagnosis = await evaluateAgentDatabaseAdmissions(config, { env });
      expect(freshDiagnosis).toEqual([]);
      recordAgentDatabaseAdmissions(freshDiagnosis, { env });
      expect(readAgentDatabaseAdmissionRefusal("cleaner", { env })).toBe(refusal);
      await expect(startup()).resolves.toBeUndefined();
      expect(readAgentDatabaseAdmissionRefusal("cleaner", { env })).toBeUndefined();
      expect(resolveRequestedSessionAgentId(config, "agent:cleaner:main")).toEqual({
        ok: true,
        agentId: "cleaner",
      });
      expect(openOpenClawAgentDatabase({ agentId: "cleaner", env }).agentId).toBe("cleaner");
      expect(fs.readFileSync(`${target}.operator-backup`)).toEqual(copyBytes);
    },
  );
});
