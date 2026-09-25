import { mock } from "node:test";
import { parentPort } from "node:worker_threads";
import type {
  CatalogInspection,
  CatalogInspectionTask,
} from "./prepared-model-catalog-inspection.js";

const port = parentPort!;
let task: CatalogInspectionTask;
let sqliteCopies = 0;
let plans: CatalogInspection["plans"] = [];
const sqlite = await import("../../infra/sqlite-snapshot-source.js");
mock.module(new URL("../../infra/sqlite-snapshot-source.ts", import.meta.url).href, {
  namedExports: {
    ...sqlite,
    prepareSqliteReadOnlyLocationSync: (
      ...args: Parameters<typeof sqlite.prepareSqliteReadOnlyLocationSync>
    ) => {
      sqliteCopies += 1;
      return sqlite.prepareSqliteReadOnlyLocationSync(...args);
    },
  },
});
const models = await import("../models-config.js");
mock.module(new URL("../models-config.ts", import.meta.url).href, {
  namedExports: {
    ...models,
    planOpenClawModelsJsonSource: async (
      ...args: Parameters<typeof models.planOpenClawModelsJsonSource>
    ) => {
      const plan = await models.planOpenClawModelsJsonSource(...args);
      plans.push(plan);
      return plan;
    },
  },
});
const catalog = await import("../prepared-model-runtime.full-catalog.js");
mock.module(new URL("../prepared-model-runtime.full-catalog.ts", import.meta.url).href, {
  namedExports: {
    ...catalog,
    prepareFullCatalogFacts: (...args: Parameters<typeof catalog.prepareFullCatalogFacts>) => {
      if (task.inspection?.failCatalog) {
        throw new Error("synthetic catalog construction failure");
      }
      return catalog.prepareFullCatalogFacts(...args);
    },
  },
});
const { getAuthoredConfigSecretRef, getConfigResolutionFacts, getResolvedConfigEnvSecretRef } =
  await import("../../config/resolution-facts.js");
const { registerResolvedAgentDir, resolveRegisteredAgentIdForDir, unregisterResolvedAgentDir } =
  await import("../agent-dir-registry.js");
const { resolveUsableCustomProviderApiKey } = await import("../model-auth-provider-config.js");
const { inspectSharedAuthLegacyRowsReadOnly } =
  await import("../auth-profiles/shared-store-bootstrap.js");

// Inspect the exact received clone and completed worker result, not a reconstructed parent copy.
port.on("message", (message: { input: CatalogInspectionTask }) => {
  task = message.input;
  sqliteCopies = 0;
  plans = [];
  for (const agentId of task.inspection?.existingAgentIds ?? []) {
    registerResolvedAgentDir({
      agentId,
      agentDir: task.value.input.agentDir,
      env: task.value.input.env,
    });
  }
});
const post = port.postMessage.bind(port);
port.postMessage = (message: { status: string; value?: object }, transferList) => {
  let response = message;
  if (message.status === "ok" && message.value) {
    const { input, sourceConfigForSecrets } = task.value;
    const runtimeFacts = getConfigResolutionFacts(input.config);
    const sourceFacts = getConfigResolutionFacts(sourceConfigForSecrets);
    const provider = task.inspection?.provider;
    const requestCopies = sqliteCopies;
    if (task.inspection?.copyProbePath) {
      inspectSharedAuthLegacyRowsReadOnly(task.inspection.copyProbePath, {
        artifactPreservingReadOnly: true,
      });
    }
    const inspection: CatalogInspection = {
      sqliteCopies: requestCopies,
      ...(task.inspection?.copyProbePath ? { copyHookObserved: sqliteCopies > requestCopies } : {}),
      plans,
      runtimeFactsAbsent: runtimeFacts === null,
      sourceFactsAbsent: sourceFacts === null,
      sameResolutionFacts: runtimeFacts === sourceFacts,
      ...(task.inspection?.existingAgentIds
        ? {
            foreignReleased: unregisterResolvedAgentDir({
              agentId: "foreign",
              agentDir: input.agentDir,
              env: input.env,
            }),
            registeredAgentId: resolveRegisteredAgentIdForDir(input.agentDir, input.env),
          }
        : {}),
      ...(provider
        ? {
            credentialMatches:
              resolveUsableCustomProviderApiKey({ cfg: input.config, provider, env: input.env })
                ?.apiKey === task.inspection?.expectedCredential,
            authoredRef: getAuthoredConfigSecretRef(
              input.config,
              `models.providers.${provider}.apiKey`,
            ),
            resolvedEnvRef: getResolvedConfigEnvSecretRef(
              input.config,
              `models.providers.${provider}.apiKey`,
            ),
          }
        : {}),
    };
    response = { ...message, value: { ...message.value, inspection } };
  }
  if (Array.isArray(transferList)) {
    post(response, transferList);
  } else {
    post(response, transferList);
  }
};
await import("../prepared-model-catalog.worker.js");
