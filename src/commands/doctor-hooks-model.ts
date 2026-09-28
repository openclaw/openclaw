import type { OpenClawConfig } from "../config/types.openclaw.js";

type HooksModelIssue = {
  kind: "unresolved" | "not-allowed" | "not-in-catalog";
  model: string;
};

export async function collectHooksModelIssues(cfg: OpenClawConfig): Promise<HooksModelIssue[]> {
  const model = cfg.hooks?.gmail?.model;
  if (!model?.trim()) {
    return [];
  }
  const { DEFAULT_MODEL, DEFAULT_PROVIDER } = await import("../agents/defaults.js");
  const { readPreparedModelCatalog } = await import("../agents/prepared-model-catalog.js");
  const { getModelRefStatus, resolveConfiguredModelRef, resolveHooksGmailModel } =
    await import("../agents/model-selection.js");
  const ref = resolveHooksGmailModel({ cfg, defaultProvider: DEFAULT_PROVIDER });
  if (!ref) {
    return [{ kind: "unresolved", model }];
  }
  const defaultModel = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const catalog = await readPreparedModelCatalog({
    config: cfg,
    readOnly: true,
    providerDiscoveryProviderIds: [],
  });
  const status = getModelRefStatus({
    cfg,
    catalog,
    ref,
    defaultProvider: defaultModel.provider,
    defaultModel,
  });
  const issues: HooksModelIssue[] = [];
  if (!status.allowed) {
    issues.push({ kind: "not-allowed", model: status.key });
  }
  if (!status.inCatalog) {
    issues.push({ kind: "not-in-catalog", model: status.key });
  }
  return issues;
}
