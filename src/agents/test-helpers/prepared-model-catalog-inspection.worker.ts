import { parentPort } from "node:worker_threads";
import { mockNativeModuleExports } from "../../../test/helpers/native-module-mock.js";
import type * as Catalog from "./prepared-model-catalog-inspection.js";

const port = parentPort!;
let task: Catalog.CatalogInspectionTask;
let sqliteCopies = 0;
let plans: Catalog.CatalogInspection["plans"] = [];
const sqlite = await import("../../infra/sqlite-snapshot-source.js");
// Bun updates existing namespace bindings when a module is mocked.
const copySqlite = sqlite.prepareSqliteReadOnlyLocationSync;
mockNativeModuleExports(new URL("../../infra/sqlite-snapshot-source.ts", import.meta.url), {
  ...sqlite,
  prepareSqliteReadOnlyLocationSync: (...args: Parameters<typeof copySqlite>) => {
    sqliteCopies += 1;
    return copySqlite(...args);
  },
});
const models = await import("../models-config.js");
const planModels = models.planOpenClawModelsJsonSource;
mockNativeModuleExports(new URL("../models-config.ts", import.meta.url), {
  ...models,
  planOpenClawModelsJsonSource: async (...args: Parameters<typeof planModels>) => {
    const plan = await planModels(...args);
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
const facts = await import("../../config/resolution-facts.js");
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
    return on(event, (message: { input: Catalog.CatalogInspectionTask }) => {
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
  if (message.status === "ok" && message.value) {
    const { input, sourceConfigForSecrets } = task.value;
    const runtimeFacts = facts.getConfigResolutionFacts(input.config);
    const sourceFacts = facts.getConfigResolutionFacts(sourceConfigForSecrets);
    const { provider, copyProbePath, existingAgentIds, expectedCredential } = task.inspection ?? {};
    const requestCopies = sqliteCopies;
    if (copyProbePath) {
      inspectSharedAuthLegacyRowsReadOnly(copyProbePath, { artifactPreservingReadOnly: true });
    }
    const inspection: Catalog.CatalogInspection = {
      sqliteCopies: requestCopies,
      ...(copyProbePath ? { copyHookObserved: sqliteCopies > requestCopies } : {}),
      plans,
      runtimeFactsAbsent: runtimeFacts === null,
      sourceFactsAbsent: sourceFacts === null,
      sameResolutionFacts: runtimeFacts === sourceFacts,
    };
    const { agentDir, env, config } = input;
    if (existingAgentIds) {
      const scope = { agentId: "foreign", agentDir, env };
      inspection.foreignReleased = unregisterResolvedAgentDir(scope);
      inspection.registeredAgentId = resolveRegisteredAgentIdForDir(agentDir, env);
    }
    if (provider) {
      const credential = resolveUsableCustomProviderApiKey({ cfg: config, provider, env });
      inspection.credentialMatches = credential?.apiKey === expectedCredential;
      const key = `models.providers.${provider}.apiKey`;
      inspection.authoredRef = facts.getAuthoredConfigSecretRef(config, key);
      inspection.resolvedEnvRef = facts.getResolvedConfigEnvSecretRef(config, key);
    }
    return post({ ...message, value: { ...message.value, inspection } }, transferList);
  }
  post(message, transferList);
};
await import("../prepared-model-catalog.worker.js");
