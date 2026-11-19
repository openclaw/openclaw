import type { ModelChoice } from "../../packages/gateway-protocol/src/schema/model-catalog.js";

/** Select only a model the host's ordinary picker currently offers for chat. */
export async function resolveTemplatePreferredModel(
  requested: string,
  loadModels: () => Promise<readonly ModelChoice[]>,
): Promise<string | undefined> {
  let models: readonly ModelChoice[];
  try {
    models = await loadModels();
  } catch {
    // A preference must not make Add depend on optional catalog readiness.
    return undefined;
  }
  const offered = models.find(
    (model) =>
      `${model.provider}/${model.id}` === requested &&
      model.available === true &&
      model.manualSelectionAllowed !== false,
  );
  return offered ? `${offered.provider}/${offered.id}` : undefined;
}
