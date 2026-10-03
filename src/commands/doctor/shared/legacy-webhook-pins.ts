import { isDeepStrictEqual } from "node:util";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChannelDoctorConfigMutation } from "../../../channels/plugins/types.adapters.js";
import { getConfigValueAtPath, setConfigValueAtPath } from "../../../config/config-paths.js";
import { resolveConfigPath, resolveIsConfigReadOnly } from "../../../config/paths.js";
import { cloneConfigWithResolutionFacts } from "../../../config/resolution-facts.js";
import type { ConfigFileSnapshot } from "../../../config/types.openclaw.js";
import { isTruthyEnvValue } from "../../../infra/env.js";
import {
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../../infra/kysely-sync.js";
import { resolveChannelConfigEnablement } from "../../../plugins/config-normalization-shared.js";
import { normalizePluginsConfig } from "../../../plugins/config-state.js";
import type { PluginDoctorHistoricalWebhookListener } from "../../../plugins/doctor-contract-module.js";
import { passesManifestOwnerBasePolicy } from "../../../plugins/manifest-owner-policy.js";
import type { PluginOrigin } from "../../../plugins/plugin-origin.types.js";
import { normalizeOptionalAccountId } from "../../../routing/account-id.js";
import { writeConfigMachineState } from "../../../state/config-machine-state-write.js";
import { readConfigMachineState } from "../../../state/config-machine-state.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../../state/openclaw-state-db-readonly.js";
import { tableExists } from "../../../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../../../state/openclaw-state-db.generated.js";

export const HISTORICAL_WEBHOOK_CHANNELS = ["telegram", "feishu", "msteams", "nextcloud-talk"];

function webhookCompletionKey(env: NodeJS.ProcessEnv): string {
  return `webhookListeners:${resolveConfigPath(env)}`;
}

/** No config bytes changed, so this completion does not depend on config rollback. */
export function recordUnwrittenWebhookCompletion(
  snapshot: Pick<ConfigFileSnapshot, "exists" | "sourceConfig">,
  mutation: ChannelDoctorConfigMutation,
  env: NodeJS.ProcessEnv,
): boolean {
  const readOnly = resolveIsConfigReadOnly(env);
  if (snapshot.exists && !readOnly) {
    return false;
  }
  const markerOnly = cloneConfigWithResolutionFacts(snapshot.sourceConfig);
  markerOnly.meta ??= {};
  markerOnly.meta.migrations ??= {};
  markerOnly.meta.migrations.webhookListeners = mutation.config.meta?.migrations?.webhookListeners;
  if (!isDeepStrictEqual(markerOnly, mutation.config)) {
    if (!readOnly) {
      return false;
    }
    throw new Error(
      `Webhook listeners need migration in the externally managed config. Add the required legacyWebhook endpoints and meta.migrations.webhookListeners completion marker in that source, then restart.\n${mutation.changes.join("\n")}`,
    );
  }
  writeConfigMachineState(webhookCompletionKey(env), markerOnly.meta.migrations.webhookListeners, {
    env,
  });
  return true;
}

/** Pins and completion travel together through Doctor's config backup and publication. */
export function applyHistoricalWebhookPins(
  mutation: ChannelDoctorConfigMutation,
  declaration: PluginDoctorHistoricalWebhookListener | undefined,
  context: {
    env?: NodeJS.ProcessEnv;
    startup?: boolean;
    pluginId?: string;
    origin?: PluginOrigin;
  } = {},
): ChannelDoctorConfigMutation {
  const env = context.env ?? process.env;
  const marker =
    mutation.config.meta?.migrations?.webhookListeners ??
    readConfigMachineState<true | Record<string, string[][]>>(webhookCompletionKey(env), { env });
  if (marker === true || mutation.warnings?.length) {
    return mutation;
  }
  const accountIds =
    (context.startup && mutation.historicalWebhookAccountIds === null) ||
    (context.pluginId &&
      !passesManifestOwnerBasePolicy({
        plugin: { id: context.pluginId },
        normalizedConfig: normalizePluginsConfig(mutation.config.plugins),
        allowRestrictiveAllowlistBypass:
          context.origin === "bundled" &&
          resolveChannelConfigEnablement(
            mutation.config,
            declaration?.channelId ?? context.pluginId,
          ) === true,
      }))
      ? []
      : mutation.historicalWebhookAccountIds;
  const existing =
    marker !== undefined ||
    isTruthyEnvValue(env.OPENCLAW_UPDATE_IN_PROGRESS) ||
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => {
        const query = getNodeSqliteKysely<DB>(db);
        return [
          query.selectFrom("gateway_boot_lifecycle").select("boot_id as evidence").limit(1),
          query.selectFrom("channel_ingress_events").select("event_id as evidence").limit(1),
          // The update ledger exists only after its first write.
          tableExists(db, "update_runs") &&
            query.selectFrom("update_runs").select("run_id as evidence").limit(1),
        ].some((statement) => statement && executeSqliteQueryTakeFirstSync(db, statement));
      },
      { env },
    );
  const completed = { ...marker };
  const channelId = declaration?.channelId;
  if (existing && (!channelId || !accountIds || Object.hasOwn(completed, channelId))) {
    return mutation;
  }
  const config = cloneConfigWithResolutionFacts(mutation.config);
  const changes = [...mutation.changes];
  if (existing && declaration) {
    const rootPath = ["channels", declaration.channelId];
    const root = asNullableRecord(getConfigValueAtPath(config, rootPath));
    const accounts = Object.keys(asNullableRecord(root?.accounts) ?? {});
    const paths: string[][] = [];
    const { channelId: _channelId, preserveAuthoredActivation, ...endpoint } = declaration;
    if (
      preserveAuthoredActivation &&
      root?.legacyWebhook !== undefined &&
      root.enabled === undefined
    ) {
      setConfigValueAtPath(config, [...rootPath, "enabled"], true);
      paths.push([...rootPath, "enabled"]);
      changes.push(`Set ${rootPath.join(".")}.enabled to preserve authored webhook activation.`);
    }
    for (const accountId of accountIds ?? []) {
      if (root?.legacyWebhook !== undefined) {
        continue;
      }
      const accountPath = [...rootPath];
      if (accountId !== undefined) {
        const matches = accounts.includes(accountId)
          ? [accountId]
          : accounts.filter(
              (id) => normalizeOptionalAccountId(id) === normalizeOptionalAccountId(accountId),
            );
        if (matches.length > 1) {
          return {
            ...mutation,
            warnings: [
              `Ambiguous ${declaration.channelId} account ${JSON.stringify(accountId)} matches ${matches.map((id) => JSON.stringify(id)).join(", ")}; no pins were written for this channel. Pin the intended account manually: channels.${declaration.channelId}.accounts[<exact account key>].legacyWebhook = ${JSON.stringify(endpoint)}.`,
            ],
          };
        }
        accountPath.push("accounts", matches[0] ?? accountId);
      }
      const pinPath = [...accountPath, "legacyWebhook"];
      if (getConfigValueAtPath(config, pinPath) !== undefined) {
        continue;
      }
      setConfigValueAtPath(config, pinPath, endpoint);
      paths.push(pinPath);
      changes.push(
        `Pinned ${accountPath.join(".")}.legacyWebhook. Move the callback or proxy to the Gateway route, then remove the pin.`,
      );
    }
    completed[declaration.channelId] = paths;
  }
  config.meta ??= {};
  config.meta.migrations ??= {};
  config.meta.migrations.webhookListeners = existing ? completed : true;
  changes.push("Recorded webhook listener decisions; removed pins will not be recreated.");
  return { ...mutation, config, changes };
}
