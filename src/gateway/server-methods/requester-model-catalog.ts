import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { readSessionRuntimeOwnershipAsync } from "../../agents/harness/session-runtime-ownership.js";
import {
  publishedModelCatalogOwnerMatchesAgent,
  resolvePublishedModelCatalogOwner,
} from "../../agents/prepared-model-catalog-owner.js";
import {
  getPublishedPreparedModelCatalogOwnerSnapshot,
  materializePreparedModelCatalogOwner,
} from "../../agents/prepared-model-catalog.js";
import { getPreparedModelRuntimeAuthMaterializations } from "../../agents/prepared-model-runtime-auth.js";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.types.js";
import { configSnapshotsMatch } from "../../config/runtime-config-snapshot-match.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginRequesterModelCatalog } from "../../plugins/model-catalog.types.js";
import { prepareOperatorModelPolicyPresentation } from "../operator-model-presentation.js";
import { readWorkerPlacementIdentity } from "../worker-environments/placement-projector.js";
import { readSessionWorkerPlacementAsync } from "../worker-environments/session-placement-lifecycle.js";
import type { ChatMetadataReadParams } from "./chat-metadata-contract.js";
import { projectSessionModelCatalog } from "./chat-metadata-session-projection.js";
import { prepareChatMetadataSessionRead } from "./chat-metadata-session-read.js";
import { prepareModelsListResult } from "./models-list-result.js";
import { projectRequesterModelCatalog } from "./requester-model-catalog-projection.js";
import type { GatewayRequestContext } from "./types.js";

/**
 * Read-only adapter over the models.list owners, without a Gateway client or refresh authority.
 * Keep preparation here: models.list also supports draft/account selectors, discovery and refresh,
 * whereas this capability may consume only published facts for its admitted saved session.
 * Session auth projection and policy presentation remain shared with models.list.
 */
export async function readRequesterModelCatalog(params: {
  config: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  authority: AdmittedRunOperatorAuthority;
  assertCurrent: () => void;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  context?: GatewayRequestContext;
}): Promise<PluginRequesterModelCatalog> {
  const { config, authority } = params;
  const policy = authority.modelPolicy;
  const assertCurrent = () => {
    params.assertCurrent();
    if (authority.modelPolicy !== policy) {
      throw new PreparedModelRuntimePublicationSupersededError("Requester model policy changed.");
    }
  };
  assertCurrent();
  const read = await prepareChatMetadataSessionRead({
    cfg: config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    assertRequestCurrent: assertCurrent,
  });
  try {
    const session = read.selected;
    const assertSessionCurrent = () => {
      assertCurrent();
      read.assertCurrent();
      if (session.entry?.sessionId !== params.sessionId) {
        throw new PreparedModelRuntimePublicationSupersededError("Requester session changed.");
      }
    };
    assertSessionCurrent();
    const placement = params.context
      ? await readSessionWorkerPlacementAsync({
          context: params.context,
          sessionId: params.sessionId,
        })
      : undefined;
    assertSessionCurrent();
    const workerInference = placement
      ? readWorkerPlacementIdentity(placement, params.context?.workerEnvironmentService)?.inference
      : undefined;
    const scope: ChatMetadataReadParams = {
      agentId: params.agentId,
      sessionKey: session.canonicalKey,
      storePath: session.readSource?.path ?? session.storePath,
      sessionEntry: session.entry,
      requesterProfileId: authority.profileId,
      ...(workerInference ? { workerInference } : {}),
      assertCurrent: assertSessionCurrent,
      withCurrent: (consume) => read.withCurrent(consume),
      beforeRequest: assertSessionCurrent,
    };
    const snapshot =
      getPublishedPreparedModelCatalogOwnerSnapshot({ config, agentId: params.agentId }) ??
      (params.preparedModelRuntime?.isCurrent() &&
      configSnapshotsMatch(params.preparedModelRuntime.config, config)
        ? params.preparedModelRuntime
        : undefined);
    if (!snapshot) {
      return await read.withCurrent(() => {
        assertSessionCurrent();
        return projectRequesterModelCatalog(
          {
            models: [],
            ...(policy ? { modelSelectionPolicy: { restricted: true, defaultModel: null } } : {}),
          },
          true,
        );
      });
    }
    const fullCatalog = snapshot.readFullModelCatalog?.();
    const prepared = fullCatalog
      ? materializePreparedModelCatalogOwner(snapshot, fullCatalog)
      : snapshot;
    const owner = resolvePublishedModelCatalogOwner(prepared);
    const assertPreparedCurrent = () => {
      assertSessionCurrent();
      if (!owner.isCurrent() || !publishedModelCatalogOwnerMatchesAgent(owner, params.agentId)) {
        throw new PreparedModelRuntimePublicationSupersededError(
          "Requester catalog owner changed.",
        );
      }
    };
    assertPreparedCurrent();
    const catalog = await prepareModelsListResult({
      source: {
        kind: "published",
        owner: {
          ...owner,
          authMaterializations: getPreparedModelRuntimeAuthMaterializations(prepared),
        },
      },
      agentId: params.agentId,
      requesterProfileId: authority.profileId,
      readScope: {
        ...scope,
        assertCurrent: assertPreparedCurrent,
        beforeRequest: assertPreparedCurrent,
      },
      params: { preparedOnly: true, includeDefaultModels: false },
      includeManualSelection: true,
    });
    assertPreparedCurrent();
    const ownership = await readSessionRuntimeOwnershipAsync({
      ...scope,
      config,
      assertCurrent: assertPreparedCurrent,
    });
    assertPreparedCurrent();
    return await read.withCurrent(() => {
      assertPreparedCurrent();
      if (!catalog.isCurrent()) {
        throw new PreparedModelRuntimePublicationSupersededError(
          "Requester account catalog changed.",
        );
      }
      const result = catalog.read();
      const models = projectSessionModelCatalog(
        scope,
        result.models,
        config,
        ownership,
        "admitted",
      );
      const projected = { ...result, models };
      const presented =
        prepareOperatorModelPolicyPresentation({
          cfg: config,
          policy,
          rolePolicy: authority.rolePolicy,
          metadataSnapshot: owner.metadataSnapshot,
        })
          ?.forAgent(params.agentId, models)
          .catalog(projected) ?? projected;
      return projectRequesterModelCatalog(
        presented,
        Boolean(snapshot.readFullModelCatalog && !fullCatalog),
      );
    });
  } finally {
    read.release();
  }
}
