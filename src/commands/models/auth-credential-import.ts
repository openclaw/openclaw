import { normalizeProviderId } from "../../agents/model-ref-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginMigrationProviders } from "../../plugins/migration-provider-runtime.js";
import type { ProviderAuthMethod } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import { buildMigrationContext } from "../migrate/context.js";
import { applyMigrationItemSelection } from "../migrate/item-selection.js";

type ImportedProviderCredential = {
  profileId: string;
  provider: string;
  mode: "api_key" | "oauth" | "token";
  configUpdated: boolean;
};

/** Imports only the credential item declared by the selected login method. */
export async function tryImportProviderCredential(params: {
  method: ProviderAuthMethod;
  providerId: string;
  config: OpenClawConfig;
  agentId: string;
  runtime: RuntimeEnv;
  signal?: AbortSignal;
  beforePersistentEffect?: () => void | Promise<void>;
}): Promise<ImportedProviderCredential | { unavailableReason: string } | undefined> {
  const spec = params.method.credentialImport;
  if (!spec) {
    return undefined;
  }
  const provider = normalizeProviderId(params.providerId);
  params.signal?.throwIfAborted();
  return await withPluginMigrationProviders(
    { providerId: spec.migrationProviderId, cfg: params.config },
    async (providers) => {
      const owner = providers.find((candidate) => candidate.id === spec.migrationProviderId);
      if (!owner) {
        return undefined;
      }
      const context = buildMigrationContext({
        targetAgentId: params.agentId,
        itemKinds: ["auth"],
        includeSecrets: true,
        configOverride: params.config,
        providerOptions: {
          allowKeychainPrompt: true,
          credentialKind: spec.credentialKind,
          configPatchMode: "none",
        },
        runtime: params.runtime,
      });
      if (params.signal) {
        context.signal = params.signal;
      }
      const plan = await owner.plan(context);
      const candidates = plan.items.filter((item) => item.id === spec.itemId);
      if (candidates.length > 1) {
        throw new Error("The credential import has an ambiguous item identity.");
      }
      const candidate = candidates[0];
      if (
        candidate?.status === "skipped" &&
        candidate.details?.credentialImportUnavailable === true
      ) {
        return candidate.message ? { unavailableReason: candidate.message } : undefined;
      }
      if (
        candidate?.kind !== "auth" ||
        candidate.status !== "planned" ||
        candidate.details?.credentialKind !== spec.credentialKind
      ) {
        return undefined;
      }
      if (
        typeof candidate.details.provider !== "string" ||
        normalizeProviderId(candidate.details.provider) !== provider
      ) {
        throw new Error("The credential import belongs to another provider.");
      }
      params.signal?.throwIfAborted();
      await params.beforePersistentEffect?.();
      params.signal?.throwIfAborted();
      const result = await owner.apply(context, applyMigrationItemSelection(plan, [spec.itemId]));
      const imported = result.items.find(
        (item) => item.id === spec.itemId && item.kind === "auth" && item.status === "migrated",
      );
      const profileId = imported?.details?.profileId;
      if (
        typeof profileId !== "string" ||
        !profileId.trim() ||
        typeof imported?.details?.provider !== "string" ||
        normalizeProviderId(imported.details.provider) !== provider ||
        imported.details.credentialKind !== spec.credentialKind
      ) {
        throw new Error(
          "The existing provider credential changed during import. Start the sign-in again.",
        );
      }
      return {
        profileId: profileId.trim(),
        provider,
        mode: spec.credentialKind,
        configUpdated: imported.details.configUpdated === true,
      };
    },
  );
}
