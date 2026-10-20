import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import {
  createModelCatalogDecisions,
  prepareModelCatalogDecisions,
} from "../../agents/model-catalog-decisions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  clearUserProfileAuthLink,
  connectUserModelAccount,
} from "../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { loadDeferredCatalog } from "../server-model-catalog-auth.js";
import { buildModelsListResult } from "./models-list-result.js";
import {
  createModelsListTestContext,
  listModels,
  providerCatalogEntry,
} from "./models-list-result.openai-routes.test-support.js";

const opus = "anthropic/claude-opus-5";
const config = {
  agents: {
    defaults: { model: { primary: opus } },
    entries: { main: { models: { [opus]: { agentRuntime: { id: "claude-cli" } } } } },
  },
} satisfies OpenClawConfig;

const token = (provider: string, expired = false, value = "synthetic-shared") => ({
  type: "token" as const,
  provider,
  token: value,
  expires: Date.now() + (expired ? -60_000 : 600_000),
});
const oauthCredential = (provider: string, expired = false, unrefreshable = false) => ({
  type: "oauth" as const,
  provider,
  access: "synthetic-access",
  refresh: unrefreshable ? "" : "synthetic-refresh",
  expires: expired ? 1 : Date.now() + 600_000,
});

async function listPrepared(
  cfg: OpenClawConfig,
  state: OpenClawTestState,
  provider: string,
  modelId: string,
  expired: boolean,
  selection: { requesterProfileId?: string; preferredProfileId?: string; pinnedProfileId?: string },
) {
  const scope = {
    cfg,
    agentId: "main",
    agentDir: state.agentDir(),
    workspaceDir: state.workspaceDir,
  };
  const context = createModelsListTestContext({
    ...scope,
    catalog: [providerCatalogEntry(provider, modelId)],
    catalogComplete: true,
    preparedAuthModes: expired ? { "claude-cli": "oauth" } : {},
  });
  const snapshot = await loadDeferredCatalog(context, "main", { readOnly: true });
  const options = {
    ...scope,
    snapshot,
    metadataSnapshot: snapshot.metadataSnapshot,
    preparedAuthStore: snapshot.authStore,
    preparedRuntimeAuthModes: snapshot.authModes,
    preparedSyntheticAuthComplete: snapshot.catalogComplete,
    ...selection,
  };
  const personal = Boolean(selection.requesterProfileId);
  const result = await buildModelsListResult({
    source: { kind: "gateway", context },
    agentId: "main",
    requesterProfileId: selection.requesterProfileId,
    params: { view: personal ? "configured" : "all", preparedOnly: true },
    preloadedCatalog: { agentId: "main", config: cfg, snapshot },
    preloadedOnly: true,
    catalogProjector: personal
      ? await prepareModelCatalogDecisions(options)
      : createModelCatalogDecisions(options),
  });
  return result.models.find((entry) => entry.provider === provider && entry.id === modelId);
}

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        modelProvider: "anthropic",
        pluginId: "anthropic",
        config: { command: "claude" },
      },
    ],
  });
});

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  vi.unstubAllEnvs();
});

it.each([
  ["api_key", false, false, true, undefined],
  [{ source: "native", mode: "oauth" }, false, false, true, undefined],
  [undefined, true, false, false, "missing-auth"],
  ["api_key", false, true, false, "missing-auth"],
  [{ source: "native", mode: "oauth" }, false, true, false, "missing-auth"],
] as const)(
  "reports CLI auth=%j, provider key=%s, plugin disabled=%s",
  async (authMode, providerApiKey, pluginDisabled, available, reason) => {
    vi.stubEnv("ANTHROPIC_API_KEY", providerApiKey ? "test-key" : "");
    const result = await listModels({
      catalog: [],
      staticEntries: [providerCatalogEntry("anthropic", "claude-opus-5")],
      cfg: pluginDisabled
        ? { ...config, plugins: { entries: { anthropic: { enabled: false } } } }
        : config,
      preparedAuthModes: authMode ? { "claude-cli": authMode } : {},
      catalogComplete: true,
      view: "configured",
      includeDefaultModels: false,
    });
    expect(result).toEqual({
      models: [expect.objectContaining({ id: "claude-opus-5", available })],
    });
    expect(result.models[0]?.unavailableReason).toBe(reason);
    expect(result.models[0]?.unavailableUntil).toBeUndefined();
  },
);

it("keeps every Claude CLI model listed as needing login before the full catalog arrives", async () => {
  const pinned = ["claude-fable-5", "claude-opus-5", "claude-sonnet-5"];
  const result = await listModels({
    catalog: [...pinned, "claude-haiku-4-5"].map((id) => providerCatalogEntry("anthropic", id)),
    cfg: {
      agents: {
        defaults: {
          model: { primary: opus },
          models: Object.fromEntries(
            pinned.map((id) => [`anthropic/${id}`, { agentRuntime: { id: "claude-cli" } }]),
          ),
        },
      },
    },
    view: "configured",
    includeDefaultModels: false,
  });
  expect(
    result.models
      .map(({ id, available, unavailableReason }) => ({ id, available, unavailableReason }))
      .toSorted((left, right) => left.id.localeCompare(right.id)),
  ).toEqual(pinned.map((id) => ({ id, available: false, unavailableReason: "missing-auth" })));
});

it.each([
  { selection: "default", expired: false, sharedOrder: false },
  { selection: "draft", expired: false, sharedOrder: true },
  { selection: "draft", expired: true, sharedOrder: true },
  { selection: "default", expired: true, sharedOrder: true },
  { selection: "default", expired: true, sharedOrder: true, oauth: true },
])(
  "uses personal $selection auth instead of native login (expired=$expired, sharedOrder=$sharedOrder, oauth=$oauth)",
  async ({ selection, expired, sharedOrder, oauth }) => {
    return withOpenClawTestState(
      { layout: "state-only", prefix: "personal-cli-model-catalog-" },
      async (state) => {
        const owner = ensureProfileForEmail("alice@example.test");
        const { authProfileId } = connectUserModelAccount({
          ownerProfileId: owner.id,
          credential: oauth
            ? oauthCredential("anthropic", true)
            : token("anthropic", expired, "synthetic-personal-token"),
          assertCurrent() {},
        });
        if (selection === "draft") {
          clearUserProfileAuthLink({ profileId: owner.id, provider: "anthropic" });
        }
        const cfg: OpenClawConfig = sharedOrder
          ? { ...config, auth: { order: { anthropic: ["anthropic:shared"] } } }
          : config;
        if (sharedOrder) {
          await state.writeAuthProfiles({
            version: 1,
            profiles: { "anthropic:shared": token("anthropic", !expired) },
          });
        }
        const model = await listPrepared(cfg, state, "anthropic", "claude-opus-5", expired, {
          requesterProfileId: owner.id,
          ...(selection === "draft"
            ? { preferredProfileId: authProfileId, pinnedProfileId: authProfileId }
            : {}),
        });
        expect(model).toMatchObject({
          agentRuntime: expect.objectContaining({ id: "claude-cli" }),
          available: !expired,
        });
        expect(model?.unavailableReason).toBe(expired && !oauth ? "auth-failed" : undefined);
      },
    );
  },
);

const cli = "claude-cli",
  api = "anthropic";
it.each([
  ["direct ready", cli, cli, cli, false, false, true, undefined],
  ["direct unavailable", cli, cli, cli, true, true, false, "auth-failed"],
  ["direct refresh-needed", cli, cli, cli, true, false, false, undefined],
  ["canonical pin", api, api, cli, true, false, true, undefined],
  ["CLI pin", api, cli, api, true, false, false, undefined],
] as const)(
  "uses the selected execution owner for %s",
  async (_name, provider, pinProvider, sharedProvider, expired, noRefresh, available, reason) =>
    withOpenClawTestState({ layout: "state-only", prefix: "cli-pin-identity-" }, async (state) => {
      const modelId = "claude-haiku-4-5";
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { model: { primary: `${provider}/${modelId}` } },
          entries: { main: {} },
        },
        auth: {
          profiles: {
            selected: { provider: pinProvider, mode: "oauth" },
            shared: { provider: sharedProvider, mode: "token" },
          },
          order: { [provider]: ["shared"] },
        },
      };
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          selected: oauthCredential(pinProvider, expired, noRefresh),
          shared: token(sharedProvider),
        },
      });
      const model = await listPrepared(cfg, state, provider, modelId, true, {
        preferredProfileId: "selected",
        pinnedProfileId: "selected",
      });
      expect([model?.available, model?.unavailableReason]).toEqual([available, reason]);
    }),
);
