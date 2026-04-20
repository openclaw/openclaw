// Public runtime auth helpers for provider plugins.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureAuthProfileStoreForLocalUpdate } from "../agents/auth-profiles/store.js";
import type { OAuthCredential } from "../agents/auth-profiles/types.js";
import { writePrivateSecretFileAtomic } from "../infra/secret-file.js";

export { resolveEnvApiKey } from "../agents/model-auth-env.js";
export {
  collectProviderApiKeysForExecution,
  executeWithApiKeyRotation,
} from "../agents/api-key-rotation.js";
export { NON_ENV_SECRETREF_MARKER } from "../agents/model-auth-markers.js";
export {
  requireApiKey,
  resolveAwsSdkEnvVarName,
  type ResolvedProviderAuth,
} from "../agents/model-auth-runtime-shared.js";
export type { ProviderPreparedRuntimeAuth } from "../plugins/types.js";
export type { ResolvedProviderRuntimeAuth } from "../plugins/runtime/model-auth-types.js";

export const CODEX_AUTH_ENV_CLEAR_KEYS = ["OPENAI_API_KEY"] as const;

const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

export type PreparedCodexAuthBridge = {
  codexHome: string;
  clearEnv: string[];
};

export function isCodexBridgeableOAuthCredential(value: unknown): value is OAuthCredential {
  return Boolean(
    value &&
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "provider" in value &&
    "access" in value &&
    "refresh" in value &&
    value.type === "oauth" &&
    value.provider === OPENAI_CODEX_PROVIDER_ID &&
    typeof value.access === "string" &&
    value.access.trim().length > 0 &&
    typeof value.refresh === "string" &&
    value.refresh.trim().length > 0,
  );
}

export function resolveCodexAuthBridgeHome(params: {
  agentDir: string;
  bridgeDir: string;
  profileId: string;
}): string {
  const digest = crypto.createHash("sha256").update(params.profileId).digest("hex").slice(0, 16);
  return path.join(params.agentDir, params.bridgeDir, "codex", digest);
}

export function buildCodexAuthBridgeFile(credential: OAuthCredential): string {
  return `${JSON.stringify(
    {
      auth_mode: "chatgpt",
      tokens: {
        ...(credential.idToken ? { id_token: credential.idToken } : {}),
        access_token: credential.access,
        refresh_token: credential.refresh,
        ...(credential.accountId ? { account_id: credential.accountId } : {}),
      },
    },
    null,
    2,
  )}\n`;
}

export async function prepareCodexAuthBridge(params: {
  agentDir: string;
  bridgeDir: string;
  profileId: string;
}): Promise<PreparedCodexAuthBridge | undefined> {
  const store = ensureAuthProfileStoreForLocalUpdate(params.agentDir);
  const credential = store.profiles[params.profileId];
  if (!isCodexBridgeableOAuthCredential(credential)) {
    return undefined;
  }

  const codexHome = resolveCodexAuthBridgeHome(params);
  await writePrivateSecretFileAtomic({
    rootDir: params.agentDir,
    filePath: path.join(codexHome, "auth.json"),
    content: buildCodexAuthBridgeFile(credential),
  });

  return {
    codexHome,
    clearEnv: [...CODEX_AUTH_ENV_CLEAR_KEYS],
  };
}

type ResolveApiKeyForProvider = typeof import("../agents/model-auth.js").resolveApiKeyForProvider;
type GetRuntimeAuthForModel =
  typeof import("../plugins/runtime/runtime-model-auth.runtime.js").getRuntimeAuthForModel;
type RuntimeModelAuthModule = typeof import("../plugins/runtime/runtime-model-auth.runtime.js");
const RUNTIME_MODEL_AUTH_CANDIDATES = [
  "./runtime-model-auth.runtime",
  "../plugins/runtime/runtime-model-auth.runtime",
] as const;
const RUNTIME_MODEL_AUTH_EXTENSIONS = [".js", ".ts", ".mjs", ".mts", ".cjs", ".cts"] as const;

function resolveRuntimeModelAuthModuleHref(): string {
  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  for (const relativeBase of RUNTIME_MODEL_AUTH_CANDIDATES) {
    for (const ext of RUNTIME_MODEL_AUTH_EXTENSIONS) {
      const candidate = path.resolve(baseDir, `${relativeBase}${ext}`);
      if (fs.existsSync(candidate)) {
        return pathToFileURL(candidate).href;
      }
    }
  }
  throw new Error(`Unable to resolve runtime model auth module from ${import.meta.url}`);
}

async function loadRuntimeModelAuthModule(): Promise<RuntimeModelAuthModule> {
  return (await import(resolveRuntimeModelAuthModuleHref())) as RuntimeModelAuthModule;
}

export async function resolveApiKeyForProvider(
  params: Parameters<ResolveApiKeyForProvider>[0],
): Promise<Awaited<ReturnType<ResolveApiKeyForProvider>>> {
  const { resolveApiKeyForProvider } = await loadRuntimeModelAuthModule();
  return resolveApiKeyForProvider(params);
}

export async function getRuntimeAuthForModel(
  params: Parameters<GetRuntimeAuthForModel>[0],
): Promise<Awaited<ReturnType<GetRuntimeAuthForModel>>> {
  const { getRuntimeAuthForModel } = await loadRuntimeModelAuthModule();
  return getRuntimeAuthForModel(params);
}
