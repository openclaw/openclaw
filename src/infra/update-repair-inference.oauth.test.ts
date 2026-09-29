import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { noteCommittedSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { SHARED_AUTH_STORE_STATE_KEY } from "../agents/auth-profiles/sqlite-json.js";
import {
  closeAuthProfileReadPool,
  readPersistedSharedAuthProfileStoreRaw,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import type { AuthProfileStore, OAuthCredential } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { selectUpdateRepairInference } from "./update-repair-inference.js";

const mocks = vi.hoisted(() => ({ probe: vi.fn(), refresh: vi.fn() }));

vi.mock("../agents/auth-profiles/store-runtime.js", async () => {
  const { createAuthProfileStoreRuntime } = await import("../agents/auth-profiles/store.js");
  const { createExternalAuthRuntime } = await import("../agents/auth-profiles/external-auth.js");
  return createAuthProfileStoreRuntime(createExternalAuthRuntime(() => []));
});
vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  formatProviderAuthProfileApiKeyWithPlugin: ({ context }: { context: OAuthCredential }) =>
    context.access,
  resolveProviderOAuthRefreshCapabilityWithPlugin: async () => ({ status: "available" }),
  resolveProviderOAuthCredentialWithPlugin: mocks.refresh,
}));
vi.mock("../agents/model-auth-runtime.js", () => ({
  prepareSyntheticLocalProviderAuth: async () => undefined,
}));
vi.mock("../agents/model-auth.js", async () => {
  const { hasAvailableAuthForProvider } = await import("../agents/model-auth-model.js");
  const { resolveApiKeyForProviderCore } = await import("../agents/model-auth-provider.js");
  return { hasAvailableAuthForProvider, resolveApiKeyForProviderCore };
});
vi.mock("../agents/model-catalog.js", () => ({ loadManifestModelCatalog: () => [] }));
vi.mock("../system-agent/setup-inference.js", () => ({ verifySetupInference: vi.fn() }));
vi.mock("../system-agent/setup-inference-turn.js", () => ({ runSetupInferenceTurn: mocks.probe }));
vi.mock("../system-agent/inference-route.js", () => ({
  resolveSystemAgentConfiguredRouteFromConfig: async (config: OpenClawConfig, agentId: string) => {
    const agent = config.agents?.entries?.[agentId];
    const raw = typeof agent?.model === "string" ? agent.model : agent?.model?.primary;
    if (!raw) {
      return null;
    }
    const [modelLabel, authProfileId] = raw.split("@");
    if (!modelLabel) {
      return null;
    }
    const [provider, model] = modelLabel.split("/");
    return {
      runner: "embedded",
      provider,
      model,
      modelLabel,
      authProfileId,
      agentId,
      agentDir: agent?.agentDir,
      runConfig: config,
      sourceConfig: config,
    };
  },
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const provider = "fixture-oauth";
const profileId = `${provider}:subscription`;

beforeEach(() => {
  mocks.probe.mockReset().mockResolvedValue({ ok: true, latencyMs: 1, text: "OK", auth: {} });
  mocks.refresh
    .mockReset()
    .mockImplementation(async ({ credential }: { credential: OAuthCredential }) => ({
      status: "available",
      credential: {
        ...credential,
        access: "synthetic-refreshed-access",
        refresh: "synthetic-rotated-refresh",
        expires: Date.now() + 3_600_000,
      },
    }));
});

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  closeAuthProfileReadPool();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

it.each([
  { expired: false, pinned: false },
  { expired: true, pinned: false },
  { expired: true, pinned: true },
])(
  "finds shared OAuth for post-failure repair ($expired expiry, pinned: $pinned)",
  async ({ expired, pinned }) => {
    const stateDir = tempDirs.make("openclaw-update-repair-oauth-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", undefined);
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    const agentDir = path.join(stateDir, "agents", "owner", "agent");
    const env = { ...process.env };
    const auth: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider,
          access: "synthetic-original-access",
          refresh: "synthetic-original-refresh",
          expires: expired ? 1 : Date.now() + 3_600_000,
        },
      },
    };
    writeConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { location: "state-db" }, { env });
    noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, env);
    writePersistedAuthProfileStoreRaw(auth);
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      agents: {
        defaults: { systemAgent: { agentId: "owner" } },
        entries: {
          owner: { agentDir, model: `${provider}/tools${pinned ? `@${profileId}` : ""}` },
        },
      },
      // An explicit pin remains usable outside automatic rotation.
      ...(pinned ? { auth: { order: { [provider]: [] } } } : {}),
    };

    const selected = await selectUpdateRepairInference({
      config,
      runtime: { log() {}, error() {}, exit() {} },
      signal: new AbortController().signal,
      timeoutMs: 10_000,
    });

    expect(selected).toMatchObject({ ok: true, route: { agentDir, provider, model: "tools" } });
    expect(mocks.probe).toHaveBeenCalledOnce();
    expect(mocks.refresh).toHaveBeenCalledTimes(expired ? 1 : 0);
    expect(readPersistedSharedAuthProfileStoreRaw(env)).toMatchObject({
      profiles: {
        [profileId]: {
          access: expired ? "synthetic-refreshed-access" : "synthetic-original-access",
        },
      },
    });
  },
);
