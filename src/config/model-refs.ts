import { normalizeProviderId } from "../agents/provider-id.js";
import { isRecord } from "../utils.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export function collectConfiguredModelRefs(cfg: OpenClawConfig): string[] {
  const refs: string[] = [];
  const pushModelRef = (value: unknown) => {
    if (typeof value === "string" && value.trim()) {
      refs.push(value.trim());
    }
  };
  const collectModelConfig = (value: unknown) => {
    if (typeof value === "string") {
      pushModelRef(value);
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    pushModelRef(value.primary);
    const fallbacks = value.fallbacks;
    if (Array.isArray(fallbacks)) {
      for (const entry of fallbacks) {
        pushModelRef(entry);
      }
    }
  };
  const collectFromAgent = (agent: Record<string, unknown> | null | undefined) => {
    if (!agent) {
      return;
    }
    for (const key of [
      "model",
      "imageModel",
      "pdfModel",
      "imageGenerationModel",
      "videoGenerationModel",
      "musicGenerationModel",
    ]) {
      collectModelConfig(agent[key]);
    }
    const models = agent.models;
    if (isRecord(models)) {
      for (const key of Object.keys(models)) {
        pushModelRef(key);
      }
    }
  };

  collectFromAgent(cfg.agents?.defaults as Record<string, unknown> | undefined);
  const list = cfg.agents?.list;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (isRecord(entry)) {
        collectFromAgent(entry);
      }
    }
  }
  return refs;
}

export function extractProviderFromModelRef(value: string): string | null {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  return normalizeProviderId(trimmed.slice(0, slash));
}
