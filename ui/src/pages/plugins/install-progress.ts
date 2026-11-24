import { isGatewayProtocolResponseError } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { Check } from "typebox/value";
import {
  PluginsInstallProgressEventSchema,
  type PluginInstallActivity,
} from "../../../../packages/gateway-protocol/src/schema/plugins.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import type { PluginInstallRequest, PluginMutationResult } from "../../lib/plugins/index.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { readPluginInstallPolicyWarning } from "./install-policy-warning.ts";

export type PluginInstallProgress = {
  startedAt: number;
  activities: readonly PluginInstallActivity[];
  finishedAt?: number;
  canRetry?: boolean;
  failure?: { title: string; recovery: string; detail: string };
};

export function describePluginInstallFailure(error: unknown) {
  const details =
    error instanceof GatewayRequestError ? asOptionalRecord(error.details) : undefined;
  const persistence = asOptionalRecord(details?.persistence);
  const policyWarning = readPluginInstallPolicyWarning(error);
  const canRetry = isGatewayProtocolResponseError(error) && !persistence && !policyWarning;
  const savedInstall =
    persistence?.operation === "install" &&
    typeof persistence.pluginId === "string" &&
    persistence.pluginId.trim()
      ? persistence.pluginId
      : undefined;
  const failureState = savedInstall
    ? "saved"
    : details?.pluginInstallRejected === true
      ? "rejected"
      : canRetry
        ? "retry"
        : "unknown";
  const failure = {
    title: t(`pluginsPage.installProgress.${failureState}.title`),
    recovery: t(`pluginsPage.installProgress.${failureState}.recovery`),
    detail: formatUiError(error),
  };
  return { details, policyWarning, canRetry, savedInstall, failure };
}

const owners = new WeakMap<ApplicationGateway, PluginInstallOperations>();

/** One application-scoped receipt owner: navigation never retires an admitted installation. */
export function pluginInstallOperations(gateway: ApplicationGateway) {
  let owner = owners.get(gateway);
  if (!owner) {
    owner = new PluginInstallOperations(gateway);
    owners.set(gateway, owner);
  }
  return owner;
}

class PluginInstallOperations {
  private readonly entries = new Map<string, PluginInstallProgress>();

  get progress(): ReadonlyMap<string, PluginInstallProgress> {
    return this.entries;
  }
  private readonly listeners = new Set<(event: { identity?: string; settled: boolean }) => void>();
  constructor(private readonly gateway: ApplicationGateway) {
    const connection = createGatewayConnectionLifecycle(gateway.snapshot);
    let client = gateway.snapshot.client;
    gateway.subscribe((snapshot) => {
      const clientChanged = snapshot.client !== client;
      const connectionChanged = connection.transition(snapshot);
      client = snapshot.client;
      if (!connectionChanged) {
        return;
      }
      if (clientChanged) {
        this.entries.clear();
      } else {
        // Only policy reviews finish without a failure: reconnect retires their
        // acknowledgement scope, not admitted writes or saved/uncertain outcomes.
        for (const [identity, progress] of this.entries) {
          if (progress.finishedAt !== undefined && !progress.failure) {
            this.entries.delete(identity);
          }
        }
      }
      // Gateway subscribers already own the reconnect refresh.
      this.publish();
    });
  }

  reconcileInstalled(catalogId: string, pluginId?: string) {
    // A newer installation fact supersedes a finished attempt, never an admitted one.
    for (const identity of ["install:" + catalogId, ...(pluginId ? ["plugin:" + pluginId] : [])]) {
      if (this.entries.get(identity)?.finishedAt !== undefined) {
        this.entries.delete(identity);
        // The reader already has authoritative state; do not trigger another read.
        this.publish(identity);
      }
    }
  }

  clearFinished(identity: string) {
    if (this.entries.get(identity)?.finishedAt !== undefined) {
      this.entries.delete(identity);
      this.publish(identity, true);
    }
  }

  subscribe(notify: (event: { identity?: string; settled: boolean }) => void) {
    this.listeners.add(notify);
    return () => this.listeners.delete(notify);
  }

  private publish(identity?: string, settled = false) {
    for (const notify of this.listeners) {
      notify({ identity, settled });
    }
  }

  async run(client: GatewayBrowserClient, request: PluginInstallRequest, identity: string) {
    let progress: PluginInstallProgress = { startedAt: Date.now(), activities: [] };
    this.entries.set(identity, progress);
    this.publish(identity);
    const current = () =>
      this.gateway.snapshot.client === client && this.entries.get(identity) === progress;
    let requestId: string | undefined;
    const unsubscribe = this.gateway.subscribeEvents((event) => {
      if (
        event.event !== "plugins.install.progress" ||
        !Check(PluginsInstallProgressEventSchema, event.payload) ||
        event.payload.requestId !== requestId ||
        !current()
      ) {
        return;
      }
      const activity = event.payload;
      const index = progress.activities.findIndex((row) => row.activityId === activity.activityId);
      progress = {
        ...progress,
        activities:
          index < 0
            ? [...progress.activities, activity]
            : progress.activities.map((row, at) => (at === index ? activity : row)),
      };
      this.entries.set(identity, progress);
      this.publish(identity);
    });
    try {
      const result = await client.request<PluginMutationResult>("plugins.install", request, {
        onSent: (id) => {
          requestId = id;
        },
      });
      if (current()) {
        this.entries.delete(identity);
        this.publish(identity, true);
      }
      return result;
    } catch (error) {
      if (current()) {
        const { canRetry, failure, policyWarning, savedInstall } =
          describePluginInstallFailure(error);
        progress = {
          ...progress,
          finishedAt: Date.now(),
          canRetry,
          ...(!policyWarning || savedInstall ? { failure } : {}),
        };
        this.entries.set(identity, progress);
        this.publish(identity, true);
      }
      throw error;
    } finally {
      unsubscribe();
    }
  }
}
