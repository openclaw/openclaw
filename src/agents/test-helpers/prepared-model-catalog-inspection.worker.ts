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

// Observe input with the real handler so initialization cannot consume queued tasks early.
const on = port.on.bind(port);
port.on = (event, listener) => {
  if (event === "message") {
    port.on = on;
    return on(event, (message: { input: CatalogInspectionTask }) => {
      task = message.input;
      sqliteCopies = 0;
      plans = [];
      const { agentDir, env } = task.value.input;
      for (const agentId of task.inspection?.existingAgentIds ?? []) {
        registerResolvedAgentDir({ agentId, agentDir, env });
      }
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
    const { provider, copyProbePath, existingAgentIds, expectedCredential } = task.inspection ?? {};
    const requestCopies = sqliteCopies;
    if (copyProbePath) {
      inspectSharedAuthLegacyRowsReadOnly(copyProbePath, { artifactPreservingReadOnly: true });
    }
    const inspection: CatalogInspection = {
      sqliteCopies: requestCopies,
      ...(copyProbePath ? { copyHookObserved: sqliteCopies > requestCopies } : {}),
      plans,
      runtimeFactsAbsent: runtimeFacts === null,
      sourceFactsAbsent: sourceFacts === null,
      sameResolutionFacts: runtimeFacts === sourceFacts,
    };
    const { agentDir, env, config } = input;
    if (existingAgentIds) {
      inspection.foreignReleased = unregisterResolvedAgentDir({
        agentId: "foreign",
        agentDir,
        env,
      });
      inspection.registeredAgentId = resolveRegisteredAgentIdForDir(agentDir, env);
    }
    if (provider) {
      inspection.credentialMatches =
        resolveUsableCustomProviderApiKey({ cfg: config, provider, env })?.apiKey ===
        expectedCredential;
      const key = `models.providers.${provider}.apiKey`;
      inspection.authoredRef = getAuthoredConfigSecretRef(config, key);
      inspection.resolvedEnvRef = getResolvedConfigEnvSecretRef(config, key);
    }
    response = { ...message, value: { ...message.value, inspection } };
  }
  post(response, transferList);
};
await import("../prepared-model-catalog.worker.js");
