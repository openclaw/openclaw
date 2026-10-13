import {
  ErrorCodes,
  errorShape,
  validateEnvironmentsAdoptSuggestedProfileParams,
  type SuggestedWorkerProfileSummary,
} from "../../../packages/gateway-protocol/src/index.js";
import { readConfigFileSnapshotForWrite, resolveConfigSnapshotHash } from "../../config/io.js";
import type { CloudWorkerProfileConfig } from "../../config/types.cloud-workers.js";
import { resolveSuggestedWorkerProfile } from "../../plugins/worker-profile-suggestions.js";
import { workerInferenceMetadata } from "../worker-environments/inference-placement.js";
import { listWorkerProfilesWithMachines } from "./environments.profiles.js";
import { respondUnavailableOnThrow } from "./response.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestContext } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

export async function listSuggestedWorkerProfile(
  context: GatewayRequestContext,
): Promise<SuggestedWorkerProfileSummary | undefined> {
  const config = context.getRuntimeConfig();
  if (Object.keys(config.cloudWorkers?.profiles ?? {}).length > 0) {
    return undefined;
  }
  const suggestion = await resolveSuggestedWorkerProfile({ config });
  if (!suggestion || context.getRuntimeConfig() !== config) {
    return undefined;
  }
  return {
    id: suggestion.id,
    providerId: suggestion.profile.provider,
    ...(suggestion.providerDisplayId ? { providerDisplayId: suggestion.providerDisplayId } : {}),
  };
}

async function savedProfileSummary(
  context: GatewayRequestContext,
  profile: CloudWorkerProfileConfig,
) {
  const summaries = await listWorkerProfilesWithMachines(context);
  return (
    summaries.find((summary) => summary.id === "cloud") ?? {
      id: "cloud",
      providerId: profile.provider,
      ...workerInferenceMetadata({ providerId: profile.provider, profileSnapshot: profile }),
    }
  );
}

export const adoptSuggestedWorkerProfile = defineValidatedGatewayHandler(
  "environments.adoptSuggestedProfile",
  validateEnvironmentsAdoptSuggestedProfileParams,
  async (options) => {
    const { context, respond } = options;
    const authority = readGatewayRequestMutationAuthority(options);
    await respondUnavailableOnThrow(respond, async () => {
      const { snapshot } = await readConfigFileSnapshotForWrite();
      authority.assertCurrent();
      const existing = snapshot.sourceConfig.cloudWorkers?.profiles?.cloud;
      if (existing) {
        const profile = await savedProfileSummary(context, existing);
        authority.assertCurrent();
        respond(true, { profile }, undefined);
        return;
      }
      const suggestion = await resolveSuggestedWorkerProfile({
        config: snapshot.config,
        refresh: true,
      });
      authority.assertCurrent();
      if (!suggestion || suggestion.id !== "cloud") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "No cloud worker profile is available to configure"),
        );
        return;
      }
      const hash = resolveConfigSnapshotHash(snapshot);
      const { configHandlers } = await import("./config.js");
      authority.assertCurrent();
      let saved = false;
      // The normal config owner validates, commits with its snapshot CAS, and awaits reload.
      await configHandlers["config.patch"]!({
        ...options,
        req: { ...options.req, method: "config.patch" },
        params: {
          raw: JSON.stringify({ cloudWorkers: { profiles: { cloud: suggestion.profile } } }),
          ...(hash ? { baseHash: context.configRevisionProjector.projectRawHash(hash) } : {}),
          response: "summary",
        },
        sessionMutationCommitGuard: authority.assertCurrent,
        respond: (ok, payload, error, meta) => {
          if (ok) {
            saved = true;
          } else {
            respond(false, payload, error, meta);
          }
        },
      });
      if (!saved) {
        return;
      }
      const profile = await savedProfileSummary(context, suggestion.profile);
      authority.assertCurrent();
      respond(true, { profile }, undefined);
    });
  },
);
