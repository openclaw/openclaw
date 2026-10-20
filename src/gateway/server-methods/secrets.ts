import {
  normalizeArrayBackedTrimmedStringList,
  normalizeTrimmedStringList,
} from "@openclaw/normalization-core/string-normalization";
import {
  ErrorCodes,
  errorShape,
  type ValidationError,
  validateSecretsResolveParams,
  validateSecretsResolveResult,
  validateSecretsStoreDeleteParams,
  validateSecretsStoreImportParams,
  validateSecretsStoreAllowedHostsParams,
  validateSecretsStoreListParams,
  validateSecretsStoreListResult,
  validateSecretsStoreMutationResult,
  validateSecretsStoreSetParams,
  type SecretStoreEntry,
  type SecretsResolveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage as errorMessage } from "../../infra/errors.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import type { resolveCommandSecretsFromActiveRuntimeSnapshot } from "../../secrets/runtime-command-secrets.js";
import { collectSecretStoreRefKeysInSnapshot } from "../../secrets/runtime-source-contract.js";
import { getActiveSecretsRuntimeSnapshotState } from "../../secrets/runtime-state.js";
import {
  deleteSecretStoreEntry,
  listSecretStoreEntries,
  purgeExpiredSecretStoreEntries,
  SecretStoreValidationError,
  writeSecretStoreEntry,
  writeSecretStoreEntries,
  updateSecretStoreAllowedHosts,
} from "../../secrets/store/secret-store.js";
import { isKnownCoreSecretTargetId, isKnownSecretTargetId } from "../../secrets/target-registry.js";
import { holdGatewayPolicyResponse } from "../server/ws-policy-close.js";
import { createAgentRuntimeAuthorityGuard } from "./agent-runtime-authority.js";
import {
  captureLocalStateMutationGuard,
  localStateOwnerChangedError,
} from "./local-state-owner.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type {
  GatewayClient,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

const teamScope = { kind: "team" } as const;

function toProtocolStoreEntry(
  entry: Awaited<ReturnType<typeof listSecretStoreEntries>>[number],
): SecretStoreEntry {
  const metadata = {
    name: entry.name,
    scopeKind: "team" as const,
    scopeId: "" as const,
    createdAtMs: entry.createdAtMs,
    updatedAtMs: entry.updatedAtMs,
    ...(entry.updatedBy ? { updatedBy: entry.updatedBy } : {}),
  };
  if (entry.kind === "env") {
    if (typeof entry.valuePreview !== "string") {
      throw new Error(`Secret store env metadata is missing its value for ${entry.name}.`);
    }
    return { ...metadata, kind: "env", value: entry.valuePreview };
  }
  return { ...metadata, kind: "secret", allowedHosts: entry.allowedHosts ?? [] };
}

function storeUpdatedBy(client: GatewayClient | null): string {
  return (
    client?.authenticatedUserProfile?.displayName?.trim() ||
    client?.connect?.client?.displayName?.trim() ||
    client?.connect?.client?.id?.trim() ||
    "gateway"
  );
}

type SecretStoreReload = (options?: {
  forceColdRefKeys?: ReadonlySet<string>;
  joinInFlight?: boolean;
}) => Promise<{ warningCount: number }>;

type SecretStoreLogger = {
  warn?: (message: string) => void;
  debug?: (message: string) => void;
};

/** Owns redaction-first store writes and the runtime refresh shared by Gateway RPCs. */
export function createSecretStoreWriteService(params: {
  reloadSecrets: SecretStoreReload;
  log?: SecretStoreLogger;
}) {
  const purgeRetention = async () => {
    try {
      await purgeExpiredSecretStoreEntries();
    } catch (error) {
      params.log?.warn?.(`secrets.store retention purge failed: ${errorMessage(error)}`);
    }
  };
  const reloadReference = async (
    names: string | readonly string[],
  ): Promise<{ reloaded: boolean; warningCount?: number }> => {
    await purgeRetention();
    const snapshot = getActiveSecretsRuntimeSnapshotState();
    const refKeys = new Set<string>();
    if (snapshot) {
      for (const name of typeof names === "string" ? [names] : names) {
        for (const key of collectSecretStoreRefKeysInSnapshot(snapshot, name)) {
          refKeys.add(key);
        }
      }
    }
    if (refKeys.size === 0) {
      return { reloaded: false };
    }
    // Explicit replacement must cold-refresh affected owners instead of
    // retaining an older credential from the active runtime snapshot.
    try {
      const reload = await params.reloadSecrets({ forceColdRefKeys: refKeys, joinInFlight: false });
      return { reloaded: true, warningCount: reload.warningCount };
    } catch (error) {
      params.log?.warn?.(`secrets.store runtime refresh failed: ${errorMessage(error)}`);
      throw error;
    }
  };

  return {
    resolveUpdatedBy: storeUpdatedBy,
    reloadReference,
    write(input: Omit<Parameters<typeof writeSecretStoreEntry>[0], "scope" | "database">) {
      // Registration precedes validation and SQLite so even write failures
      // cannot disclose the submitted credential through downstream logging.
      registerSecretValueForRedaction(input.value);
      return writeSecretStoreEntry({ scope: teamScope, ...input });
    },
  };
}

export type SecretStoreWriteService = ReturnType<typeof createSecretStoreWriteService>;

function invalidSecretsResolveField(
  errors: ValidationError[] | null | undefined,
): keyof SecretsResolveParams {
  // Return the offending top-level field only. Detailed validator output can
  // include paths and schema internals that are not useful for callers here.
  for (const issue of errors ?? []) {
    const instancePath = issue.instancePath ?? "";
    if (
      instancePath === "/commandName" ||
      (instancePath === "" &&
        (String(issue.params?.missingProperty) === "commandName" ||
          (Array.isArray(issue.params?.requiredProperties) &&
            issue.params.requiredProperties.includes("commandName"))))
    ) {
      return "commandName";
    }
    for (const field of [
      "allowedPaths",
      "forcedActivePaths",
      "optionalActivePaths",
      "providerOverrides",
    ] as const) {
      if (instancePath.startsWith(`/${field}`)) {
        return field;
      }
    }
  }
  return "targetIds";
}

export function createSecretsHandlers(params: {
  reloadSecrets: SecretStoreReload;
  storeWriteService: SecretStoreWriteService;
  resolveSecrets: (
    params: SecretsResolveParams,
  ) => ReturnType<typeof resolveCommandSecretsFromActiveRuntimeSnapshot>;
  log?: SecretStoreLogger;
}): GatewayRequestHandlers {
  const mutateStore = <TParams extends { expectedOwnerId?: string }>(
    action: "set" | "delete" | "import" | "allowedHosts",
    names: string[],
    options: Omit<GatewayRequestHandlerOptions, "params"> & { params: TParams },
    mutate: (
      requestParams: TParams,
      assertCurrent: (() => void) | undefined,
      client: GatewayClient | null,
    ) => Promise<unknown>,
  ) => {
    const { params: requestParams, respond, client, context } = options;
    const requestAuthority = readGatewayRequestMutationAuthority(options);
    let assertOwner: (() => void) | undefined;
    try {
      assertOwner = requestParams.expectedOwnerId
        ? captureLocalStateMutationGuard(requestParams.expectedOwnerId, options)
        : undefined;
    } catch (error) {
      respond(false, undefined, localStateOwnerChangedError(error));
      return Promise.resolve();
    }
    const authority = createAgentRuntimeAuthorityGuard(client, context, respond, () => {
      requestAuthority.assertCurrent();
      assertOwner?.();
    });
    let mutationResult: unknown;
    const attempt = async () => {
      if (action === "delete") {
        const agentId = client?.internal?.agentRuntimeIdentity?.agentId;
        if (agentId) {
          params.log?.debug?.(`secrets.store.delete requested by agent:${agentId}`);
        }
      }
      if (!authority.ensureActive()) {
        return false;
      }
      holdGatewayPolicyResponse(respond);
      mutationResult = await mutate(requestParams, authority.commitGuard, client);
      return true;
    };
    return (async () => {
      const method = `secrets.store.${action}`;
      let committed = false;
      try {
        if (!(await attempt())) {
          return;
        }
        committed = true;
        authority.commitGuard?.();
        const result = {
          ok: true as const,
          ...(await params.storeWriteService.reloadReference(names)),
          ...(requestParams.expectedOwnerId &&
          action === "set" &&
          (mutationResult === "secret" || mutationResult === "env")
            ? { kind: mutationResult }
            : {}),
        };
        if (!validateSecretsStoreMutationResult(result)) {
          throw new Error(`${method} returned invalid payload.`);
        }
        respond(true, result);
      } catch (error) {
        if (!committed && error instanceof SecretStoreValidationError) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
          return;
        }
        params.log?.warn?.(`${method} failed: ${errorMessage(error)}`);
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            !committed
              ? `${method} failed`
              : action !== "delete"
                ? "Secret store entry was saved, but post-write runtime refresh failed. Resolve provider errors and retry secrets.reload."
                : "Secret store entry was deleted, but the active runtime could not refresh. Update the config reference or restore the entry, then retry secrets.reload.",
          ),
        );
      }
    })();
  };
  return {
    "secrets.reload": async ({ respond }) => {
      try {
        holdGatewayPolicyResponse(respond);
        const result = await params.reloadSecrets();
        respond(true, { ok: true, warningCount: result.warningCount });
      } catch (error) {
        params.log?.warn?.(`secrets.reload failed: ${errorMessage(error)}`);
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "secrets.reload failed"));
      }
    },
    "secrets.resolve": async ({ params: requestParams, respond }) => {
      if (!validateSecretsResolveParams(requestParams)) {
        const field = invalidSecretsResolveField(validateSecretsResolveParams.errors);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `invalid secrets.resolve params: ${field}`),
        );
        return;
      }
      const commandName = requestParams.commandName.trim();
      if (!commandName) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid secrets.resolve params: commandName"),
        );
        return;
      }
      const targetIds = normalizeTrimmedStringList(requestParams.targetIds);
      // Normalize allow/force/optional path lists before resolving so secrets
      // code receives policy paths, not UI whitespace artifacts.
      const allowedPaths = normalizeArrayBackedTrimmedStringList(requestParams.allowedPaths);
      const forcedActivePaths = normalizeArrayBackedTrimmedStringList(
        requestParams.forcedActivePaths,
      );
      const optionalActivePaths = normalizeArrayBackedTrimmedStringList(
        requestParams.optionalActivePaths,
      );
      const providerOverrides = {
        ...(requestParams.providerOverrides?.webSearch?.trim()
          ? { webSearch: requestParams.providerOverrides.webSearch.trim() }
          : {}),
        ...(requestParams.providerOverrides?.webFetch?.trim()
          ? { webFetch: requestParams.providerOverrides.webFetch.trim() }
          : {}),
      };

      // Target ids are a closed registry. Reject unknown ids before resolving
      // so callers cannot probe arbitrary config paths through this method.
      for (const targetId of targetIds) {
        if (!isKnownCoreSecretTargetId(targetId) && !isKnownSecretTargetId(targetId)) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `invalid secrets.resolve params: unknown target id "${String(targetId)}"`,
            ),
          );
          return;
        }
      }

      try {
        const result = await params.resolveSecrets({
          commandName,
          targetIds,
          ...(allowedPaths ? { allowedPaths } : {}),
          ...(forcedActivePaths ? { forcedActivePaths } : {}),
          ...(optionalActivePaths ? { optionalActivePaths } : {}),
          ...(Object.keys(providerOverrides).length > 0 ? { providerOverrides } : {}),
        });
        const payload = {
          ok: true,
          assignments: result.assignments,
          diagnostics: result.diagnostics,
          inactiveRefPaths: result.inactiveRefPaths,
        };
        if (!validateSecretsResolveResult(payload)) {
          // Validate the returned shape as a final boundary check before any
          // secret assignment payload leaves the gateway.
          throw new Error("secrets.resolve returned invalid payload.");
        }
        respond(true, payload);
      } catch (error) {
        params.log?.warn?.(`secrets.resolve failed: ${errorMessage(error)}`);
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "secrets.resolve failed"));
      }
    },
    "secrets.store.list": defineValidatedGatewayHandler(
      "secrets.store.list",
      validateSecretsStoreListParams,
      async (options) => {
        const { respond } = options;
        const { assertCurrent } = readGatewayRequestMutationAuthority(options);
        try {
          const result = {
            entries: (await listSecretStoreEntries({ scope: teamScope, assertCurrent })).map(
              toProtocolStoreEntry,
            ),
          };
          assertCurrent();
          if (!validateSecretsStoreListResult(result)) {
            throw new Error("secrets.store.list returned invalid payload.");
          }
          respond(true, result);
        } catch (error) {
          params.log?.warn?.(`secrets.store.list failed: ${errorMessage(error)}`);
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, "secrets.store.list failed"),
          );
        }
      },
    ),
    "secrets.store.set": defineValidatedGatewayHandler(
      "secrets.store.set",
      validateSecretsStoreSetParams,
      (options) =>
        mutateStore("set", [options.params.name], options, (requestParams, assertCurrent, client) =>
          params.storeWriteService.write({
            name: requestParams.name,
            value: requestParams.value,
            kind: requestParams.kind,
            inheritExistingKind: requestParams.inheritExistingKind,
            valueSource: requestParams.valueSource,
            ...(requestParams.allowedHosts !== undefined
              ? { allowedHosts: requestParams.allowedHosts }
              : {}),
            updatedBy: params.storeWriteService.resolveUpdatedBy(client),
            assertCurrent,
          }),
        ),
    ),
    "secrets.store.import": defineValidatedGatewayHandler(
      "secrets.store.import",
      validateSecretsStoreImportParams,
      (options) =>
        mutateStore(
          "import",
          options.params.entries.map((entry) => entry.name),
          options,
          (requestParams, assertCurrent, client) =>
            writeSecretStoreEntries({
              scope: teamScope,
              entries: requestParams.entries,
              inheritExistingKind: requestParams.inheritExistingKind,
              updatedBy: params.storeWriteService.resolveUpdatedBy(client),
              assertCurrent,
            }),
        ),
    ),
    "secrets.store.allowedHosts": defineValidatedGatewayHandler(
      "secrets.store.allowedHosts",
      validateSecretsStoreAllowedHostsParams,
      (options) =>
        mutateStore(
          "allowedHosts",
          [options.params.name],
          options,
          (requestParams, assertCurrent, client) =>
            updateSecretStoreAllowedHosts({
              scope: teamScope,
              name: requestParams.name,
              allowedHosts: requestParams.allowedHosts,
              updatedBy: params.storeWriteService.resolveUpdatedBy(client),
              assertCurrent,
            }),
        ),
    ),
    "secrets.store.delete": defineValidatedGatewayHandler(
      "secrets.store.delete",
      validateSecretsStoreDeleteParams,
      (options) =>
        mutateStore("delete", [options.params.name], options, (requestParams, assertCurrent) =>
          deleteSecretStoreEntry({
            scope: teamScope,
            name: requestParams.name,
            assertCurrent,
          }),
        ),
    ),
  };
}
