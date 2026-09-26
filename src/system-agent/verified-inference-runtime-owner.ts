import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { loadAuthProfileStoreForRuntime } from "../agents/auth-profiles/store-runtime.js";
import { resolveCliRuntimeOwnerFingerprint } from "../agents/cli-auth-epoch.js";
import {
  fingerprintAuthProfileOwnerShape,
  fingerprintAwsSdkRuntimeOwner,
  fingerprintOpaqueRuntimeOwner,
  type OpaqueRuntimeOwnerKind,
} from "../agents/execution-auth-binding.js";
import { resolveApiKeyForProviderCore } from "../agents/model-auth-provider.js";
import type {
  SystemAgentVerifiedInferenceBinding,
  SystemAgentVerifiedInferenceDeps,
} from "./verified-inference.js";

export async function resolveCurrentRuntimeOwnerFingerprint(params: {
  route: SystemAgentVerifiedInferenceBinding["execution"];
  kind: OpaqueRuntimeOwnerKind;
  runtimeOwnerId: string;
  authProfileId?: string;
  modelId?: string;
  modelApi?: string;
  skipLocalCredential?: boolean;
  runtimeArtifactFingerprint?: string;
  deps: SystemAgentVerifiedInferenceDeps;
}): Promise<string | undefined> {
  if (params.route.runner === "cli") {
    if (params.kind !== "cli-runtime") {
      return undefined;
    }
    const resolveOwner =
      params.deps.resolveCliRuntimeOwnerFingerprint ?? resolveCliRuntimeOwnerFingerprint;
    return resolveOwner({
      provider: params.route.provider,
      config: params.route.runConfig,
      agentDir: params.route.agentDir,
      agentId: params.route.agentId,
      runtimeOwnerId: params.runtimeOwnerId,
      ...(params.authProfileId ? { authProfileId: params.authProfileId } : {}),
      ...(params.skipLocalCredential ? { skipLocalCredential: true } : {}),
      ...(params.runtimeArtifactFingerprint
        ? { runtimeArtifactFingerprint: params.runtimeArtifactFingerprint }
        : {}),
    });
  }
  let authProfileOwnerFingerprint: string | undefined;
  if (params.authProfileId) {
    const loadStore = params.deps.loadAuthProfileStoreForRuntime ?? loadAuthProfileStoreForRuntime;
    const store = loadStore(params.route.agentDir, {
      readOnly: true,
      migrationProvider: params.route.provider,
      allowKeychainPrompt: false,
      config: params.route.runConfig,
      externalCliProviderIds: [params.route.provider],
    });
    authProfileOwnerFingerprint = fingerprintAuthProfileOwnerShape({
      profileId: params.authProfileId,
      credential: store.profiles[params.authProfileId],
    });
    if (!authProfileOwnerFingerprint) {
      return undefined;
    }
  }
  if (params.kind === "plugin-harness") {
    if (params.route.agentHarnessRuntimeOverride === "openclaw") {
      return undefined;
    }
    return fingerprintOpaqueRuntimeOwner({
      kind: "plugin-harness",
      runner: "embedded",
      provider: params.route.provider,
      backendId: params.route.agentHarnessRuntimeOverride,
      ...(params.runtimeArtifactFingerprint
        ? { runtimeArtifactFingerprint: params.runtimeArtifactFingerprint }
        : {}),
      ...(params.authProfileId ? { authProfileId: params.authProfileId } : {}),
      ...(authProfileOwnerFingerprint ? { authProfileOwnerFingerprint } : {}),
    });
  }
  if (params.kind !== "aws-sdk") {
    return undefined;
  }
  // SDK selection is transport-sensitive, just like credential selection.
  if (!params.modelId || !params.modelApi) {
    return undefined;
  }
  const resolveAuth = params.deps.resolveApiKeyForProvider ?? resolveApiKeyForProviderCore;
  const auth = await resolveAuth({
    provider: params.route.provider,
    cfg: params.route.runConfig,
    agentDir: params.route.agentDir,
    workspaceDir: resolveAgentWorkspaceDir(
      params.route.runConfig,
      params.route.agentId,
      process.env,
    ),
    ...(params.authProfileId
      ? { profileId: params.authProfileId, lockedProfile: true as const }
      : { allowAuthProfileFallback: false }),
    modelId: params.modelId,
    modelApi: params.modelApi,
    secretSentinels: true,
  });
  if (params.authProfileId && auth.profileId !== params.authProfileId) {
    return undefined;
  }
  return fingerprintAwsSdkRuntimeOwner({
    provider: params.route.provider,
    backendId: params.route.agentHarnessRuntimeOverride,
    auth,
  });
}
