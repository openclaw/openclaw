import path from "node:path";
import type { StatementSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { loadCombinedSessionStoreForGatewayCore } from "../../config/sessions/combined-store-gateway.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import * as transcriptWorker from "../../config/sessions/session-transcript-worker-runtime.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { bumpGatewayAccessRevision } from "../gateway-access-revision.js";
import { projectsHandlers as registeredProjectsHandlers } from "./projects.js";
import {
  initializeRepository,
  invokeProjectMethod,
  listRegistryRecords,
  projectsHandlers,
  resolveRepositoryIdentity,
} from "./projects.test-support.js";

export function registerPreparedProjectReadTests() {
  test("registered projects.list reads recents and observed session rows off the caller thread", async () => {
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "projects-worker-",
    });
    try {
      const repo = await initializeRepository(state.root);
      const profile = ensureProfileForEmail("projects-worker@example.test");
      const cfg = {
        agents: { entries: { main: { workspace: state.workspaceDir } } },
      };
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:project-worker" },
        {
          sessionId: "project-worker",
          updatedAt: 20,
          spawnedCwd: repo,
          execCwd: repo,
          createdActor: { type: "human", source: "profile", id: profile.id },
        },
      );
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const prototype: StatementSync = Object.getPrototypeOf(database.db.prepare("SELECT 1"));
      const observer = observeSqliteReadSql(prototype);
      const rowQueries = () => observer.queries.filter((sql) => /session_nodes/i.test(sql));
      try {
        loadCombinedSessionStoreForGatewayCore(cfg);
        expect(rowQueries().length).toBeGreaterThan(0);
        observer.queries.length = 0;
        for (let round = 0; round < 2; round++) {
          expect(
            await invokeProjectMethod(
              "projects.list",
              { includeObserved: true },
              cfg,
              ["operator.write"],
              profile.id,
              registeredProjectsHandlers,
            ),
          ).toMatchObject({
            ok: true,
            payload: {
              recents: [{ kind: "folder", folder: repo, displayName: "registered" }],
              observedProjects: [
                { checkouts: [{ runnerId: "gateway", path: repo }], lastUsedAt: 20 },
              ],
            },
          });
        }
        expect(rowQueries()).toEqual([]);
      } finally {
        observer.restore();
      }
    } finally {
      await state.cleanup();
    }
  });

  test.each(["write scope", "session access", "registry access", "probe access"])(
    "projects.list rechecks %s after preparation",
    async (change) => {
      const state = await createOpenClawTestState({
        layout: "state-only",
        prefix: "projects-worker-scope-",
      });
      const read = transcriptWorker.withSessionHistoryWorkerDatabases;
      let restoreRead = () => {};
      try {
        const profile = ensureProfileForEmail("projects-scope@example.test");
        const cfg = {
          agents: { entries: { main: { workspace: state.workspaceDir } } },
        };
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: "agent:main:scope" },
          {
            sessionId: "scope",
            updatedAt: 1,
            spawnedCwd: "/private/project",
            execCwd: "/private/project",
            createdActor: { type: "human", source: "profile", id: profile.id },
          },
        );
        const scopes = ["operator.write"];
        const observer = vi
          .spyOn(transcriptWorker, "withSessionHistoryWorkerDatabases")
          .mockImplementation(async (options, operation) => {
            const result = await read(options, operation);
            if (change === "write scope") {
              scopes.splice(0, scopes.length, "operator.read");
            } else if (change === "session access") {
              bumpGatewayAccessRevision();
            }
            return result;
          });
        restoreRead = () => observer.mockRestore();
        if (change === "probe access") {
          resolveRepositoryIdentity.mockImplementationOnce(async (checkoutPath) => {
            bumpGatewayAccessRevision();
            return {
              checkoutRoot: checkoutPath,
              repoRoot: checkoutPath,
              originUrl: "",
              fingerprint: checkoutPath,
            };
          });
        }
        if (change === "registry access") {
          listRegistryRecords.mockImplementationOnce(async () => {
            bumpGatewayAccessRevision();
            return [];
          });
        }
        const result = await invokeProjectMethod(
          "projects.list",
          { includeObserved: true },
          cfg,
          scopes,
          profile.id,
          change === "probe access" || change === "registry access"
            ? projectsHandlers
            : registeredProjectsHandlers,
        );
        if (change !== "write scope") {
          expect(result).toMatchObject({
            ok: false,
            error: {
              code: "UNAVAILABLE",
              message: expect.stringContaining("Project access changed"),
            },
          });
          expect(result?.payload).toBeUndefined();
          return;
        }
        expect(result).toEqual({
          ok: true,
          payload: {
            projects: [
              {
                id: "workspace:main",
                displayName: path.basename(state.workspaceDir),
                source: "workspace",
                agentId: "main",
              },
            ],
            recents: [],
          },
          error: undefined,
        });
        expect(observer).toHaveBeenCalled();
      } finally {
        restoreRead();
        await state.cleanup();
      }
    },
  );
}
