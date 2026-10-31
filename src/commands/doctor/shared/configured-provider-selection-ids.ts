import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString as normalizeId } from "@openclaw/normalization-core/string-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

export function collectConfiguredModelProviderSelectionIds(
  cfg: OpenClawConfig,
): ReadonlySet<string> {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    const id = normalizeId(value);
    if (id) {
      ids.add(id.toLowerCase());
    }
  };
  const addModelRef = (value: string) => {
    const slash = value.indexOf("/");
    if (slash > 0) {
      add(value.slice(0, slash));
    }
  };
  for (const profile of Object.values(asNullableRecord(cfg.auth?.profiles) ?? {})) {
    add(asNullableRecord(profile)?.provider);
  }
  for (const providerId of Object.keys(asNullableRecord(cfg.models?.providers) ?? {})) {
    add(providerId);
  }
  const modelByChannel = asNullableRecord(cfg.channels?.modelByChannel);
  for (const [providerId, channelMap] of Object.entries(modelByChannel ?? {})) {
    add(providerId);
    for (const modelRef of Object.values(asNullableRecord(channelMap) ?? {})) {
      if (typeof modelRef !== "string") {
        continue;
      }
      addModelRef(modelRef);
    }
  }
  for (const { value } of collectConfiguredModelRefs(cfg, {
    includeChannelModelOverrides: false,
  })) {
    addModelRef(value);
  }
  return ids;
}

export function collectConfiguredMediaProviderSelectionIds(
  cfg: OpenClawConfig,
): ReadonlySet<string> {
  const models = cfg.tools?.media?.models;
  return new Set(
    normalizeTrimmedStringList(
      Array.isArray(models) ? models.map((model) => asNullableRecord(model)?.provider) : [],
    ).map((provider) => provider.toLowerCase()),
  );
}

/** Provider ids used by static and installed-registry plugin matching. */
export function collectConfiguredProviderSelectionIds(cfg: OpenClawConfig): ReadonlySet<string> {
  return new Set([
    ...collectConfiguredModelProviderSelectionIds(cfg),
    ...collectConfiguredMediaProviderSelectionIds(cfg),
  ]);
}
