import { createHash } from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  validatePluginsCredentialsSetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { assertConfigWriteAllowedInCurrentMode } from "../../config/config-write-guard.js";
import { readConfigFileSnapshot, readConfigFileSnapshotForWrite } from "../../config/config.js";
import { ConfigWritePostCommitError } from "../../config/io.write-errors.js";
import type { RuntimeConfigWriteApplicationStatus } from "../../config/runtime-write-application.js";
import { withConfigWriteLock } from "../../config/write-lock.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { normalizePluginsConfig } from "../../plugins/config-state.js";
import { resolvePluginCredentialDescriptors } from "../../plugins/credential-descriptors.js";
import { inspectPluginCredentialValue } from "../../plugins/credential-inspection.js";
import { resolveManagedPluginMetadata } from "../../plugins/management-service.js";
import {
  hasExplicitManifestOwnerTrust,
  passesManifestOwnerBasePolicy,
} from "../../plugins/manifest-owner-policy.js";
import { getPath, setPathCreateStrict } from "../../secrets/path-utils.js";
import { resolveDefaultSecretProviderAlias } from "../../secrets/ref-contract.js";
import { assertSecretStoreValue } from "../../secrets/store/secret-store-validation-error.js";
import { withSecretStoreStagedWrite } from "../../secrets/store/secret-store-worker.js";
import { formatConcreteConfigPath, parseConcreteConfigPathTokens } from "../../shared/dot-path.js";
import { holdGatewayPolicyResponse } from "../server/ws-policy-close.js";
import { commitGatewayConfigWrite } from "./config-write-flow.js";
import type { SecretStoreWriteService } from "./secrets.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

/** The exact plugin/path pair owns this store name; arbitrary existing refs are never adopted. */
function pluginCredentialStoreName(pluginId: string, path: readonly (string | number)[]): string {
  return (
    "PLUGIN_CREDENTIAL_" +
    createHash("sha256")
      .update(JSON.stringify([pluginId, path]))
      .digest("hex")
      .toUpperCase()
  );
}

export function createPluginCredentialSetHandlers(
  service: Pick<SecretStoreWriteService, "reloadReference" | "resolveUpdatedBy">,
): GatewayRequestHandlers {
  return {
    "plugins.credentials.set": async (options) => {
      const { params, client, context, respond, signal, hasCurrentClientAuthority } = options;
      if (
        !assertValidParams(
          params,
          validatePluginsCredentialsSetParams,
          "plugins.credentials.set",
          respond,
        )
      ) {
        return;
      }
      registerSecretValueForRedaction(params.value);
      const assertAuthority = () => {
        if (
          !client ||
          client.invalidated ||
          client.connectionSignal?.aborted ||
          signal?.aborted ||
          !client.connect.scopes?.includes("operator.admin") ||
          (hasCurrentClientAuthority && !hasCurrentClientAuthority())
        ) {
          throw new Error("Administrator access changed");
        }
      };
      const descriptor = () => {
        assertAuthority();
        const config = context.getRuntimeConfig();
        const metadata = resolveManagedPluginMetadata(config, process.env);
        const plugin = metadata.byPluginId.get(params.pluginId);
        const normalizedConfig = normalizePluginsConfig(config.plugins);
        if (
          !plugin ||
          !passesManifestOwnerBasePolicy({ plugin, normalizedConfig }) ||
          !(
            plugin.origin === "bundled" ||
            plugin.origin === "config" ||
            hasExplicitManifestOwnerTrust({ plugin, normalizedConfig })
          )
        ) {
          throw new Error("Plugin is unavailable");
        }
        const field = resolvePluginCredentialDescriptors(plugin).find(
          (candidate) =>
            candidate.storage === "protected" &&
            JSON.stringify(candidate.path) === JSON.stringify(params.path),
        );
        if (!field) {
          throw new Error("Credential is not declared");
        }
        return field;
      };
      let application: Promise<RuntimeConfigWriteApplicationStatus> | undefined;
      let queueFollowUp: (() => void) | undefined;
      let committed = false;
      let retainedAfterUncertainPublication = false;
      try {
        const admitted = descriptor();
        assertConfigWriteAllowedInCurrentMode();
        assertSecretStoreValue(params.value, "secret", "plugin credential");
        const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
        descriptor();
        if (
          !snapshot.valid ||
          !snapshot.hash ||
          context.configRevisionProjector.projectRawHash(snapshot.hash) !== params.baseHash
        ) {
          throw new Error("Configuration changed");
        }
        const name = pluginCredentialStoreName(params.pluginId, params.path);
        const inspected = inspectPluginCredentialValue(
          snapshot.sourceConfig,
          admitted,
          process.env,
        );
        const ref = {
          source: "store",
          provider:
            inspected.kind === "reference"
              ? inspected.ref.provider
              : resolveDefaultSecretProviderAlias(snapshot.sourceConfig, "store", {
                  preferFirstProviderForSource: true,
                }),
          id: name,
        } as const;
        if (
          inspected.kind === "invalid" ||
          (inspected.kind === "reference" &&
            (inspected.ref.source !== ref.source || inspected.ref.id !== ref.id))
        ) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "This credential uses a different source. Update its key at that source, or manage its reference in plugin settings.",
            ),
          );
          return;
        }
        const path = admitted.path.map(String);
        const rawHash = snapshot.hash;
        holdGatewayPolicyResponse(respond);
        await withConfigWriteLock(
          snapshot.path,
          async () => {
            descriptor();
            const current = await readConfigFileSnapshot();
            descriptor();
            if (current.path !== snapshot.path || current.hash !== rawHash) {
              throw new Error("Configuration changed");
            }
            await withSecretStoreStagedWrite(
              {
                scope: { kind: "team" },
                name,
                value: params.value,
                kind: "secret",
                updatedBy: service.resolveUpdatedBy(client),
              },
              () => {
                descriptor();
              },
              async (stage) => {
                try {
                  descriptor();
                  const nextConfig = structuredClone(current.sourceConfig);
                  setPathCreateStrict(
                    nextConfig,
                    parseConcreteConfigPathTokens(
                      formatConcreteConfigPath(path, current.sourceConfig),
                    ),
                    ref,
                  );
                  const written = await commitGatewayConfigWrite({
                    snapshot,
                    nextConfig,
                    context,
                    respond,
                    awaitRuntimeApplication: true,
                    writeOptions: {
                      ...writeOptions,
                      assertCurrent: () => {
                        descriptor();
                      },
                      expectedConfigPath: snapshot.path,
                    },
                  });
                  application = written.application;
                  queueFollowUp = written.queueFollowUp;
                  committed = true;
                } catch (error) {
                  // An uncertain publication may already reference the staged value. Reconcile the
                  // original target, never delete it or retry the mutation based on an exception alone.
                  let compensate =
                    !(error instanceof ConfigWritePostCommitError) ||
                    error.rollbackStatus === "restored";
                  if (!compensate) {
                    const observed = await readConfigFileSnapshot().catch(() => undefined);
                    compensate = Boolean(
                      observed?.valid &&
                      observed.path === snapshot.path &&
                      observed.hash === snapshot.hash &&
                      JSON.stringify(getPath(observed.sourceConfig, path)) !== JSON.stringify(ref),
                    );
                  }
                  if (compensate) {
                    // A refused or lost compensation is not evidence that the staged bytes vanished.
                    retainedAfterUncertainPublication = true;
                    retainedAfterUncertainPublication = !(await stage.rollback());
                  } else {
                    retainedAfterUncertainPublication = true;
                  }
                  throw error;
                }
              },
            );
          },
          process.env,
          () => {
            descriptor();
          },
        );
        let warning: string | undefined;
        if (application) {
          const status = await application;
          if (status !== "applied" && status !== "unclaimed") {
            warning = "Credential saved. Runtime application needs attention; reload Settings.";
          }
        }
        // Stable references need the canonical cold reload even when the authored config did not change.
        try {
          const refreshed = await service.reloadReference(name);
          if ((refreshed.warningCount ?? 0) > 0) {
            warning =
              "Credential saved. Runtime secret warnings remain; check Settings before using it.";
          }
        } catch {
          warning = "Credential saved, but runtime refresh failed. Reload secrets before using it.";
        }
        respond(true, { saved: true, ...(warning ? { warning } : {}) }, undefined);
      } catch {
        // Never echo loader, worker, or candidate errors carrying private authoring bytes.
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            committed || retainedAfterUncertainPublication
              ? "Credential was stored, but connection settings could not be confirmed. Reload Settings before retrying."
              : "Credential could not be saved. Reload Settings and check administrator access, plugin enablement, and the existing reference before retrying.",
          ),
        );
      } finally {
        queueFollowUp?.();
      }
    },
  };
}
