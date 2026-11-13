import { vi } from "vitest";
import { loadSessionEntryReadOnly } from "../../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { prepareGatewayRecipientProfile } from "../../src/gateway/expected-profile.js";
import { createSessionMutationTestContext } from "../../src/gateway/server-methods/sessions-mutations.owner.test-support.js";
import type {
  GatewayClient,
  GatewayRequestContext,
} from "../../src/gateway/server-methods/types.js";
import {
  registerGatewayModelCatalogPrivateAccess,
  type PreparedGatewayModelCatalogSnapshot,
} from "../../src/gateway/server-model-catalog-auth.js";
import { buildSessionCatalogImportKey } from "../../src/gateway/session-create-key.js";
import { bindSessionRowProjection } from "../../src/gateway/session-row-projection-access.js";
import type { createSessionRowProjection } from "../../src/gateway/session-row-projection.js";
import { createSubsystemLogger } from "../../src/logging/subsystem.js";
import { readVisibleSessionTranscriptMessageEntries } from "../../src/plugin-sdk/session-transcript-runtime.js";
import { createPluginMetadataSnapshotFixture } from "../../src/plugins/plugin-metadata.test-support.js";
import type { createOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

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
