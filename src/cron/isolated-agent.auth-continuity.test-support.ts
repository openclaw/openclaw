import { zstdDecompressSync } from "node:zlib";
import { getAiTransportHost } from "@openclaw/ai";
import { afterEach, beforeEach, vi } from "vitest";
import { installPrivateUpdateHandoffStore } from "../../test/helpers/private-update-handoff-store.js";
import { disposeAllSessionMcpRuntimes } from "../agents/agent-bundle-mcp-manager-api.js";
import { bindSessionMcpRuntimeTestScheduler } from "../agents/agent-bundle-mcp-manager.test-support.js";
import { removeAuthProfilesAcrossOwnerStores } from "../agents/auth-profiles/profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import { providerResponse } from "../agents/embedded-agent-runner.wire.test-support.js";
import { modelDefinition as authModelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import "../agents/ai-transport-runtime-host.js"; // Initialize before spies; lazy setup copies the host.
import { resetSessionControllerStateForTest } from "../sessions/session-lifecycle-admission.test-support.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { captureCronInferenceBinding } from "./inference-binding.runtime.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent/run.js";
import { TEST_SCHEDULED_OCCURRENCE } from "./scheduled-occurrence.test-support.js";
import { runCronSessionTurn } from "./session-run.js";
import type { CronStoredJob } from "./types.js";
export const platformId = "openai:platform";
export const subscriptionId = "openai:subscription";
export const otherPlatformId = "openai:other-platform";
export const otherSubscriptionId = "openai:other-subscription";
export const platformKey = "synthetic-platform-key";
export const subscriptionToken = [
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
  Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } }),
  ).toString("base64url"),
  "synthetic-signature",
].join(".");

export const modelIds = ["gpt-4.1", "gpt-4o"];
export const runtimeModels = (...ids: string[]) =>
  Object.fromEntries(
    ids.map((id) => [id, { agentRuntime: { id: "openclaw" }, params: { transport: "sse" } }]),
  );

export const modelDefinition = (id: string) =>
  authModelDefinition(id, { reasoning: false, contextWindow: 128_000, maxTokens: 1024 });

export function provider(
  baseUrl: string,
  api: "openai-responses" | "openai-chatgpt-responses" = "openai-responses",
  ids = ["gpt-4.1"],
) {
  return { api, baseUrl, agentRuntime: { id: "openclaw" }, models: ids.map(modelDefinition) };
}

export function configure(
  state: OpenClawTestState,
  defaults: NonNullable<OpenClawConfig["agents"]>["defaults"],
  providers: NonNullable<OpenClawConfig["models"]>["providers"],
  auth?: OpenClawConfig["auth"],
): OpenClawConfig {
  return {
    plugins: { allow: ["openai"], slots: { memory: "none" } },
    skills: { load: { watch: false } },
    tools: { deny: ["*"] },
    auth,
    agents: {
      entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
      defaults,
    },
    models: { mode: "replace", providers },
  };
}

export async function writeConfig(state: OpenClawTestState, cfg: OpenClawConfig) {
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
}

export async function runStoredTurn(
  cfg: OpenClawConfig,
  job: CronStoredJob,
  agentRuntimeOverride?: string,
) {
  if (job.sessionTarget.startsWith("session:")) {
    await import("../auto-reply/dispatch.js");
    const runtime = await import("../auto-reply/reply/get-reply-from-config.runtime.js");
    await runtime.prewarmConfigDrivenReplyRuntime();
    const sessionKey = job.sessionTarget.slice(8);
    await replaceSessionEntry(
      { agentId: "main", sessionKey },
      {
        sessionId: job.id,
        updatedAt: Date.now(),
        agentRuntimeOverride,
      },
    );
    return runCronSessionTurn({
      occurrence: TEST_SCHEDULED_OCCURRENCE,
      cfg,
      job,
      agentId: "main",
      sessionKey,
      text: job.payload.kind === "agentTurn" ? job.payload.message : "",
      admissionSource: "operator-schedule",
      deliveryAttemptFence: null,
      assertCurrent() {},
    });
  }
  return runCronIsolatedAgentTurn({
    occurrence: TEST_SCHEDULED_OCCURRENCE,
    cfg,
    deps: {},
    job,
    deliveryAttemptFence: null,
    message: job.payload.kind === "agentTurn" ? job.payload.message : "",
    sessionKey: `cron:${job.id}`,
    lane: "cron",
  });
}

export function interceptProvider(fetch: typeof globalThis.fetch) {
  vi.spyOn(globalThis, "fetch").mockImplementation(fetch);
  vi.spyOn(getAiTransportHost(), "buildModelFetch").mockReturnValue(fetch);
}

export async function requestedModel(request: Request): Promise<string> {
  const bytes = Buffer.from(await request.arrayBuffer());
  const body: unknown = JSON.parse(
    request.headers.get("content-encoding") === "zstd"
      ? zstdDecompressSync(bytes).toString("utf8")
      : bytes.toString("utf8"),
  );
  if (!body || typeof body !== "object" || !("model" in body) || typeof body.model !== "string") {
    throw new Error("Expected a serialized provider model request");
  }
  return body.model;
}

export async function changeAccount(profileId: string, replace: boolean) {
  if (replace) {
    await persistAuthProfileBatch({
      profiles: [keyProfile(profileId, "synthetic-replacement-key")],
    });
  } else {
    await removeAuthProfilesAcrossOwnerStores({ profileIds: [profileId] });
  }
}

export async function captureAccounts(cfg: OpenClawConfig, model: string) {
  const primary = await captureCronInferenceBinding({ cfg, agentId: "main" });
  const alternate = await captureCronInferenceBinding({ cfg, agentId: "main", model });
  if (!primary || !alternate) {
    throw new Error("Expected stored accounts");
  }
  return { primary, alternate };
}

export async function omitPrimary(state: OpenClawTestState, cfg: OpenClawConfig, mode: string) {
  if (!mode.startsWith("changed primary")) {
    return;
  }
  const defaults = cfg.agents!.defaults!;
  const model = defaults.model;
  if (!model || typeof model === "string") {
    throw new Error("Expected fallback policy");
  }
  model.primary = "local/gpt-4.1";
  Object.assign(defaults.models!, runtimeModels("local/gpt-4.1"));
  cfg.models!.providers!.local = provider("https://changed.invalid/v1");
  await writeConfig(state, cfg);
  if (mode.endsWith("revoked") || mode.endsWith("replaced")) {
    await changeAccount(platformId, mode.endsWith("replaced"));
  }
}

export function keyProfile(profileId: string, key: string) {
  return { profileId, credential: { type: "api_key" as const, provider: "openai", key } };
}

export function oauthProfile(
  profileId: string,
  access: string,
  refresh = "synthetic-refresh",
  accountId = "synthetic-account",
) {
  return {
    profileId,
    credential: {
      type: "oauth" as const,
      provider: "openai",
      access,
      refresh,
      expires: Date.now() + 3_600_000,
      accountId,
    },
  };
}

export function storedJob(id: string, message = "Reply."): CronStoredJob {
  return {
    id,
    name: id,
    agentId: "main",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    delivery: { mode: "none" },
    payload: { kind: "agentTurn", message, lightContext: true },
    state: {},
  };
}

export function withAuthState<T>(label: string, run: (state: OpenClawTestState) => Promise<T>) {
  return withOpenClawTestState(
    {
      label,
      env: { OPENAI_API_KEY: undefined, OPENAI_OAUTH_TOKEN: undefined, OPENAI_BASE_URL: undefined },
    },
    async (state) => {
      installPrivateUpdateHandoffStore(state.root);
      return run(state);
    },
  );
}

export function quotaResponse(): Response {
  return Response.json(
    { error: { code: "insufficient_quota", message: "Quota exhausted" } },
    { status: 429 },
  );
}

export function completedResponse(model: string): Response {
  return providerResponse({
    api: "openai-responses",
    model,
    id: "resp_synthetic",
    messageId: "msg_synthetic",
    text: "same authorized account",
    calls: [],
  }).response;
}

export function installCronAuthContinuityHooks() {
  beforeEach(bindSessionMcpRuntimeTestScheduler);

  afterEach(async () => {
    await disposeAllSessionMcpRuntimes();
    await resetPreparedModelRuntimeSnapshotsForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    resetSessionControllerStateForTest();
    vi.restoreAllMocks();
  });
}
