import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { saveAuthProfileStore } from "../agents/auth-profiles.js";
import { refreshPreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  retireSqliteDatabaseAdmissionForPath,
  revokeSqliteDatabaseAdmissionsForPath,
} from "../infra/sqlite-database-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { readAgentDatabaseReadAdmissionRefusal } from "../state/agent-database-admission.js";
import type { getAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";

/** Leave the first agent clean; the remaining stores require writable inspection. */
export async function prepareAgentHandoffStores(agentIds: string[], env: NodeJS.ProcessEnv) {
  saveAuthProfileStore({
    version: 1,
    profiles: {
      "anthropic:fleet": {
        type: "api_key",
        provider: "anthropic",
        keyRef: { source: "env", provider: "default", id: "OPENCLAW_TEST_FLEET_SECRET" },
      },
    },
  });
  const paths = agentIds.map((agentId) => openOpenClawAgentDatabase({ agentId, env }).path);
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
  for (const pathname of paths) {
    retireSqliteDatabaseAdmissionForPath(pathname);
  }
  for (const pathname of paths.slice(1)) {
    revokeSqliteDatabaseAdmissionsForPath(pathname);
    const database = new DatabaseSync(pathname);
    database.exec("PRAGMA journal_mode=DELETE; DROP INDEX idx_agent_session_nodes_active");
    database.close();
  }
}

/** Hold a real prepared agent's cleanup while its sibling publishes through the Gateway. */
export function holdInspectedAgentHandoff(
  admission: NonNullable<ReturnType<typeof getAgentDatabaseStartupAdmission>>,
  options: {
    firstAgent: string;
    cleanup: "success" | "reject";
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
  },
) {
  const { firstAgent, cleanup, env, signal } = options;
  const firstPublished = createDeferredCore();
  const firstReleasing = createDeferredCore();
  const secondPublished = createDeferredCore<boolean>();
  const releaseFirst = createDeferredCore();
  const activate = admission.activate.bind(admission);
  vi.spyOn(admission, "activate").mockImplementation((activation) =>
    activate({
      ...activation,
      // Minimal Gateways omit the normal post-listener configured model publication.
      preparationReady: activation.preparationReady.then(() =>
        refreshPreparedModelRuntimeSnapshots(getRuntimeConfig(), {
          gatewayLifecycle: true,
          catalogMode: "static",
          allowGatewaySubagentBinding: true,
        }),
      ),
      openAgent: async (input) => {
        if (input.agentId !== firstAgent) {
          await withinTest(firstPublished.promise, signal);
        }
        const opened = await activation.openAgent(input);
        return {
          [Symbol.asyncDispose]: async () => {
            await opened?.[Symbol.asyncDispose]();
            if (input.agentId === firstAgent) {
              firstReleasing.resolve();
              await withinTest(releaseFirst.promise, signal);
              if (cleanup === "reject") {
                throw new Error("synthetic prepared cleanup failure");
              }
            }
          },
        };
      },
      publishAgent: async (input) => {
        const firstVisible = !readAgentDatabaseReadAdmissionRefusal(firstAgent, { env });
        const revoke = await activation.publishAgent(input);
        if (input.agentId === firstAgent) {
          firstPublished.resolve();
        } else {
          secondPublished.resolve(firstVisible);
        }
        return revoke;
      },
    }),
  );
  return { firstPublished, firstReleasing, secondPublished, releaseFirst };
}
