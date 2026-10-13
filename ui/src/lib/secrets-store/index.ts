import type {
  SecretStoreEntry,
  SecretsStoreListResult,
  SecretsStoreMutationResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { ENV_SECRET_REF_ID_RE } from "../../../../src/config/types.secrets.js";
import { isSensitiveEnvName } from "../../../../src/secrets/secret-env-name.js";
import { parseSecretStoreDotEnvText } from "../../../../src/secrets/store/dotenv.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../format-error.ts";

export type SecretsStoreDraft = {
  name: string;
  value: string;
  kind: "secret" | "env";
  allowedHosts: string;
};

type SecretsStoreBulkEntry = Omit<SecretsStoreDraft, "allowedHosts">;

export type SecretsStoreState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  entries: SecretStoreEntry[];
  loaded: boolean;
  loading: boolean;
  busy: boolean;
  error: string | null;
};

export function createInitialSecretsStoreState(
  snapshot: Partial<Pick<SecretsStoreState, "client" | "connected">> = {},
): SecretsStoreState {
  return {
    client: snapshot.client ?? null,
    connected: snapshot.connected ?? false,
    entries: [],
    loaded: false,
    loading: false,
    busy: false,
    error: null,
  };
}

async function refreshSnapshot(
  state: SecretsStoreState,
  client: GatewayBrowserClient,
): Promise<boolean> {
  const result = await client.request<SecretsStoreListResult>("secrets.store.list", {});
  if (state.client !== client || !state.connected) {
    return false;
  }
  state.entries = result.entries;
  state.loaded = true;
  return true;
}

export async function loadSecretsStore(state: SecretsStoreState): Promise<boolean> {
  const client = state.client;
  if (!client || !state.connected || state.loading) {
    return false;
  }
  state.loading = true;
  state.error = null;
  try {
    return await refreshSnapshot(state, client);
  } catch (error) {
    if (state.client === client) {
      state.error = formatUiError(error);
    }
    return false;
  } finally {
    if (state.client === client) {
      state.loading = false;
    }
  }
}

type SingleStoreMutation = (client: GatewayBrowserClient) => Promise<SecretsStoreMutationResult>;
type BulkStoreMutation = { entries: readonly SecretsStoreBulkEntry[] };
type BulkStoreResult = { saved: number; warningCount: number };

function mutateAndReload(
  state: SecretsStoreState,
  mutation: SingleStoreMutation,
): Promise<SecretsStoreMutationResult | null>;
function mutateAndReload(
  state: SecretsStoreState,
  mutation: BulkStoreMutation,
): Promise<BulkStoreResult | null>;
async function mutateAndReload(
  state: SecretsStoreState,
  mutation: SingleStoreMutation | BulkStoreMutation,
): Promise<SecretsStoreMutationResult | BulkStoreResult | null> {
  const client = state.client;
  const bulk = typeof mutation !== "function";
  if (!client || !state.connected || state.busy || (bulk && mutation.entries.length === 0)) {
    return null;
  }
  state.busy = true;
  state.error = null;
  let result: SecretsStoreMutationResult | null = null;
  let saved = 0;
  let warningCount = 0;
  let mutationError: unknown;
  try {
    if (bulk) {
      for (const entry of mutation.entries) {
        const reply = await client.request<SecretsStoreMutationResult>("secrets.store.set", entry);
        saved += 1;
        warningCount = Math.max(warningCount, reply.warningCount ?? 0);
        await refreshSnapshot(state, client);
      }
    } else {
      result = await mutation(client);
    }
  } catch (error) {
    mutationError = bulk
      ? new Error(
          t("secretsStore.partial", {
            saved: String(saved),
            total: String(mutation.entries.length),
            error: formatUiError(error),
          }),
        )
      : error;
  }
  try {
    if (!bulk || mutationError) {
      await refreshSnapshot(state, client);
    }
  } catch (error) {
    mutationError ??= error;
  } finally {
    if (state.client === client) {
      state.busy = false;
      state.error = mutationError ? formatUiError(mutationError) : null;
    }
  }
  return mutationError ? null : bulk ? { saved, warningCount } : result;
}

export function setSecretsStoreEntry(
  state: SecretsStoreState,
  draft: SecretsStoreDraft,
): Promise<SecretsStoreMutationResult | null> {
  return mutateAndReload(state, (client) =>
    client.request<SecretsStoreMutationResult>("secrets.store.set", {
      name: draft.name,
      value: draft.value,
      kind: draft.kind,
      ...(draft.kind === "secret"
        ? {
            allowedHosts: draft.allowedHosts.split(/[\s,]+/u).filter(Boolean),
          }
        : {}),
    }),
  );
}

export function deleteSecretsStoreEntry(
  state: SecretsStoreState,
  name: string,
): Promise<SecretsStoreMutationResult | null> {
  return mutateAndReload(state, (client) =>
    client.request<SecretsStoreMutationResult>("secrets.store.delete", { name }),
  );
}

export function parseSecretsStoreBulkInput(
  raw: string,
  autoDetectSecrets: boolean,
): { entries: SecretsStoreBulkEntry[]; invalidNames: string[] } {
  const parsed = parseSecretStoreDotEnvText(raw);
  const invalidNames = Object.keys(parsed).filter((name) => !ENV_SECRET_REF_ID_RE.test(name));
  const entries: SecretsStoreBulkEntry[] = Object.entries(parsed).map(([name, value]) => ({
    name,
    value,
    kind: autoDetectSecrets && isSensitiveEnvName(name) ? "secret" : "env",
  }));
  return { entries, invalidNames };
}

export function bulkSetSecretsStoreEntries(
  state: SecretsStoreState,
  entries: readonly SecretsStoreBulkEntry[],
): Promise<{ saved: number; warningCount: number } | null> {
  return mutateAndReload(state, { entries });
}
