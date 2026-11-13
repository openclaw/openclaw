import { vi } from "vitest";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { readVisibleSessionTranscriptMessageEntries } from "../../plugin-sdk/session-transcript-runtime.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import type { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import {
  registerGatewayModelCatalogPrivateAccess,
  type PreparedGatewayModelCatalogSnapshot,
} from "../server-model-catalog-auth.js";
import { buildSessionCatalogImportKey } from "../session-create-key.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import type { createSessionRowProjection } from "../session-row-projection.js";
import { createSessionMutationTestContext } from "./sessions-mutations.owner.test-support.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

export async function prepareNativeCatalogImport(params: {
  cfg: OpenClawConfig;
  state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  projection: Awaited<ReturnType<typeof createSessionRowProjection>>;
  client: GatewayClient;
  threadId: string;
}) {
  const { cfg, state, projection, client, threadId } = params;
  if (cfg.gateway?.roles?.definitions?.reader) {
    cfg.gateway.roles.definitions.reader.scopes = ["operator.read", "operator.write"];
  }
  if (!client.connect.scopes?.includes("operator.admin")) {
    client.connect.scopes = ["operator.read", "operator.write"];
  }
  await state.writeConfig(cfg);
  prepareGatewayRecipientProfile(client);
  const snapshot = {
    entries: [],
    routeVariants: [],
    agentId: "main",
    agentDir: state.agentDir(),
    workspaceDir: state.workspaceDir,
    catalogComplete: true,
    config: cfg,
    observationConfig: cfg,
    authModes: {},
    authStore: { version: 1, profiles: {} },
    metadataSnapshot: createPluginMetadataSnapshotFixture({ plugins: [] }),
    authMaterializations: [],
    isCurrent: () => true,
  } satisfies PreparedGatewayModelCatalogSnapshot;
  const prepared = async () => snapshot;
  const loader: GatewayRequestContext["loadGatewayModelCatalogSnapshot"] = prepared;
  registerGatewayModelCatalogPrivateAccess(loader, {
    loadDeferred: prepared,
    readPrepared: prepared,
  });
  const context = bindSessionRowProjection(
    {
      ...createSessionMutationTestContext(cfg),
      logGateway: createSubsystemLogger("test/native-catalog-import"),
      broadcast: vi.fn(),
      getRuntimeConfig: () => cfg,
      loadGatewayModelCatalogSnapshot: loader,
    },
    () => projection,
  );
  const key = buildSessionCatalogImportKey("main", {
    catalogId: "pi",
    hostId: "gateway",
    threadId,
  });
  const entry = () => loadSessionEntryReadOnly({ agentId: "main", sessionKey: key });
  const transcript = async () => {
    const current = entry();
    return current
      ? readVisibleSessionTranscriptMessageEntries({
          agentId: "main",
          sessionKey: key,
          sessionId: current.sessionId,
        })
      : [];
  };
  return { context, key, entry, transcript };
}
