import { parentPort } from "node:worker_threads";
import { mockNativeModuleExports } from "../../../test/helpers/native-module-mock.js";
import type {
  CatalogInspection,
  CatalogInspectionTask,
} from "./prepared-model-catalog-inspection.js";

const port = parentPort!;
let task: CatalogInspectionTask;
let sqliteCopies = 0;
let plans: CatalogInspection["plans"] = [];
const sqlite = await import("../../infra/sqlite-snapshot-source.js");
// Bun updates existing namespace bindings when a module is mocked.
const prepareSqliteReadOnlyLocationSync = sqlite.prepareSqliteReadOnlyLocationSync;
mockNativeModuleExports(new URL("../../infra/sqlite-snapshot-source.ts", import.meta.url), {
  ...sqlite,
  prepareSqliteReadOnlyLocationSync: (
    ...args: Parameters<typeof prepareSqliteReadOnlyLocationSync>
  ) => {
    sqliteCopies += 1;
    return prepareSqliteReadOnlyLocationSync(...args);
  },
});
const models = await import("../models-config.js");
const planOpenClawModelsJsonSource = models.planOpenClawModelsJsonSource;
mockNativeModuleExports(new URL("../models-config.ts", import.meta.url), {
  ...models,
  planOpenClawModelsJsonSource: async (
    ...args: Parameters<typeof planOpenClawModelsJsonSource>
  ) => {
    const plan = await planOpenClawModelsJsonSource(...args);
    plans.push(plan);
    return plan;
  },
});
const catalog = await import("../prepared-model-runtime.full-catalog.js");
const prepareFullCatalogFacts = catalog.prepareFullCatalogFacts;
mockNativeModuleExports(new URL("../prepared-model-runtime.full-catalog.ts", import.meta.url), {
  ...catalog,
  prepareFullCatalogFacts: (...args: Parameters<typeof prepareFullCatalogFacts>) => {
    if (task.inspection?.failCatalog) {
      throw new Error("synthetic catalog construction failure");
    }
    return prepareFullCatalogFacts(...args);
  },
});
const { getAuthoredConfigSecretRef, getConfigResolutionFacts, getResolvedConfigEnvSecretRef } =
  await import("../../config/resolution-facts.js");
const { registerResolvedAgentDir, resolveRegisteredAgentIdForDir, unregisterResolvedAgentDir } =
  await import("../agent-dir-registry.js");
const { resolveUsableCustomProviderApiKey } = await import("../model-auth-provider-config.js");
const { inspectSharedAuthLegacyRowsReadOnly } =
  await import("../auth-profiles/shared-store-bootstrap.js");

function inspectInput(message: { input: CatalogInspectionTask }) {
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
}
// Observe input with the real handler so initialization cannot consume queued tasks early.
const on = port.on.bind(port);
port.on = (event, listener) => {
  if (event === "message") {
    port.on = on;
    return on(event, (message: { input: CatalogInspectionTask }) => {
      inspectInput(message);
      Reflect.apply(listener, port, [message]);
    });
  }
  return on(event, listener);
};
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
