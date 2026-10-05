import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createCustomNativeCommandChoiceFixture } from "../../agents/model-runtime-choice.test-support.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.types.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { testState } from "../test-helpers.runtime-state.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";

const publication = vi.hoisted((): { owner?: PreparedModelRuntimeSnapshot } => ({}));
vi.mock("../../agents/prepared-model-catalog.js", () => ({
  getPublishedPreparedModelCatalogOwnerSnapshot: () => publication.owner,
  materializePreparedModelCatalogOwner: (owner: PreparedModelRuntimeSnapshot) => owner,
  loadProviderScopedThinkingCatalog: async () => publication.owner?.modelCatalog.entries ?? [],
}));

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
afterEach(() => {
  publication.owner = undefined;
  vi.restoreAllMocks();
});

test("sessions.create derives Codex for an available unowned native-command catalog model without starting a turn", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const fixture = await createCustomNativeCommandChoiceFixture();
  const rootDir = await fs.mkdtemp(path.join(dir, "codex-manifest-"));
  const installed = createColdPluginFixture({
    rootDir,
    pluginId: "codex",
    manifest: { activation: { onAgentHarnesses: ["codex"] } },
  });
  fixture.cfg.plugins = { ...fixture.cfg.plugins, load: { paths: [rootDir] } };
  const { writeConfigFile } = await getGatewayConfigModule();
  await writeConfigFile(fixture.cfg);
  testState.agentConfig = fixture.cfg.agents?.defaults;
  setActivePluginRegistry(fixture.pluginRegistry);
  publication.owner = fixture.owner;
  const runAttempt = vi.spyOn(fixture.harness, "runAttempt");
  const key = "agent:main:dashboard:custom-native-create";
  const created = await directSessionReq<{ entry: { agentRuntimeOverride?: string } }>(
    "sessions.create",
    { key, agentId: "main", model: `${fixture.provider}/${fixture.model}`, message: "" },
    { context: { loadGatewayModelCatalogSnapshot: async () => fixture.owner.modelCatalog } },
  );
  expect(created.ok, created.error?.message).toBe(true);
  expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toMatchObject({
    providerOverride: fixture.provider,
    modelOverride: fixture.model,
    agentRuntimeOverride: "codex",
  });
  expect(runAttempt).not.toHaveBeenCalled();
  expect(isColdPluginRuntimeLoaded(installed)).toBe(false);
});
