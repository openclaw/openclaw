import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { loadSessionMcpConfig } from "../agents/agent-bundle-mcp-runtime-config.js";
import type { SessionMcpRequesterScope } from "../agents/agent-bundle-mcp-types.js";
import { listAgentIds, resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
} from "../agents/agent-tools.policy.js";
import { McpConnectionAuthorityError } from "../agents/mcp-connection-authority-error.js";
import { partitionMcpServersByConnectionScope } from "../agents/mcp-connection-resolver.js";
import { prepareMcpEventCredentialConnection } from "../agents/mcp-event-connection.js";
import { requestMcpEvent } from "../agents/mcp-event-request.js";
import { resolveSenderToolPolicy } from "../agents/sender-tool-policy.js";
import { collectExplicitDenylist } from "../agents/tool-policy.js";
import { isChannelAccountExplicitlyDisabled } from "../channels/account-config-enabled.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobEffectiveAgentId } from "../cron/agent-id.js";
import { resolveCronScheduledToolPolicy } from "../cron/scheduled-tool-policy.js";
import {
  resolveCronAuthenticatedCallerOrigin,
  resolveCronAuthenticatedChannelRequester,
} from "../cron/tools-allow-provenance.js";
import type { CronStoredJob } from "../cron/types.js";
import { createScheduledGatewayRunner } from "../gateway/scheduled-run-gateway-context.js";
import type { GatewayContextResolver } from "../gateway/server-methods/types.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import type { PluginRuntimeCapabilityLease } from "./capability-lease.js";
import type { OpenClawPluginServiceContext } from "./plugin-registration.types.js";
import type { PluginServiceCronHost } from "./service-cron.js";

type Capability = NonNullable<OpenClawPluginServiceContext["mcpEvents"]>;
const MAX_SUBSCRIPTION_TTL_MS = 60 * 60_000;
const CLEANUP_GRACE_MS = 5 * 60_000;
const MAX_PREPARED_SOURCES = 4096;

/** Prepared native caller facts. Neither plugin request parameters nor callbacks can supply these. */
export type McpEventPrincipal = {
  agentId: string;
  sessionKey?: string;
  requester?: SessionMcpRequesterScope;
  account?: { id: string; channel?: string };
};

/** The shared config/auth owner, also used by the pre-creation Gateway catalog. */
export async function prepareMcpEventConnection(params: {
  cfg: OpenClawConfig;
  principal: McpEventPrincipal;
  serverName: string;
  assertCurrent: () => void;
}) {
  const { cfg, principal, serverName } = params;
  params.assertCurrent();
  if (!listAgentIds(cfg).includes(principal.agentId)) {
    throw new Error("MCP Events agent is no longer configured.");
  }
  let sessionChanged = false;
  let disposed = false;
  let credentialConnection:
    | Awaited<ReturnType<typeof prepareMcpEventCredentialConnection>>
    | undefined;
  const releaseSession = sessionChanges.subscribeFacts((change) => {
    if (
      "all" in change ||
      (principal.sessionKey &&
        change.sessionKey === principal.sessionKey &&
        (!change.agentId || change.agentId === principal.agentId))
    ) {
      sessionChanged = true;
    }
  });
  const release = () => {
    if (!disposed) {
      disposed = true;
      credentialConnection?.release();
      releaseSession();
    }
  };
  const assertPolicyCurrent = () => {
    params.assertCurrent();
    if (disposed || sessionChanged) {
      throw new Error("MCP Events creator session changed; resolve its authority again.");
    }
  };
  const assertCurrent = () => {
    assertPolicyCurrent();
    credentialConnection?.assertCurrent();
  };
  try {
    const entry = principal.sessionKey
      ? await withSessionEntryReadOnlyInWorker(
          {
            agentId: principal.agentId,
            sessionKey: principal.sessionKey,
          },
          assertCurrent,
          async (read) => {
            if (!read.ok) {
              throw new Error("MCP Events creator session cannot be read.");
            }
            return read.value;
          },
        )
      : undefined;
    assertCurrent();
    if (principal.sessionKey && !entry) {
      throw new Error("MCP Events creator session is unavailable.");
    }
    const policies = resolveEffectiveToolPolicy({
      config: cfg,
      agentId: principal.agentId,
      sessionKey: principal.sessionKey,
    });
    if (
      principal.account?.channel &&
      isChannelAccountExplicitlyDisabled({
        cfg,
        channel: principal.account.channel,
        accountId: principal.account.id,
      })
    ) {
      throw new Error("MCP Events creator account is disabled.");
    }
    const groupPolicy = principal.account
      ? resolveGroupToolPolicy({
          config: cfg,
          sessionKey: principal.sessionKey,
          accountId: principal.account.id,
          messageProvider: principal.account.channel,
          requireConfiguredAccount: true,
          senderPolicyMode: principal.requester ? "always" : "never",
          senderId: principal.requester?.requesterSenderId,
        })
      : undefined;
    const senderPolicy = principal.requester
      ? resolveSenderToolPolicy({
          config: cfg,
          agentId: principal.agentId,
          sessionKey: principal.sessionKey,
          messageProvider: principal.requester.messageChannel,
          senderId: principal.requester.requesterSenderId,
        })
      : undefined;
    // Events are not tool calls. Whole-server denials still prohibit connecting;
    // individual tool grants remain the Automation execution owner's responsibility.
    const toolDenylist = collectExplicitDenylist([
      policies.globalPolicy,
      policies.agentPolicy,
      groupPolicy,
      senderPolicy,
    ]);
    const { loaded, fingerprint: configurationIdentity } = loadSessionMcpConfig({
      cfg,
      workspaceDir: resolveAgentWorkspaceDir(cfg, principal.agentId),
      toolOverrides: entry?.toolOverrides,
      includeServerNames: new Set([serverName]),
      toolDenylist,
      logDiagnostics: false,
    });
    const server = loaded.mcpServers[serverName];
    if (!server || entry?.toolOverrides?.mcpToolsDeny?.[serverName]?.includes("*")) {
      throw new Error("MCP Events server is unavailable under the creator's policy.");
    }
    const partition = partitionMcpServersByConnectionScope({ [serverName]: server });
    if (partition.requesterScopedServerNames.length && !principal.requester) {
      throw new Error("MCP Events requires the original authenticated requester for this server.");
    }
    credentialConnection = await prepareMcpEventCredentialConnection(
      {
        serverName,
        server,
        cfg,
        agentDir: resolveAgentDir(cfg, principal.agentId),
        requesterScope: principal.requester,
        requesterResolver: partition.resolverRequesterServerNames.length > 0,
      },
      assertPolicyCurrent,
    );
    assertCurrent();
    return {
      ...credentialConnection,
      // Prepared before requester resolution: never fingerprint resolved credentials.
      configurationIdentity,
      assertCurrent,
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}

function jobPrincipal(job: CronStoredJob, defaultAgentId?: string): McpEventPrincipal {
  const policy = resolveCronScheduledToolPolicy({
    toolsAllow: job.payload.toolsAllow,
    owner: job.owner,
    scheduledToolPolicy: job.scheduledToolPolicy,
  });
  if (!policy) {
    throw new Error("MCP Events requires a verified Automation creator policy.");
  }
  const agentId = resolveCronJobEffectiveAgentId(job, defaultAgentId);
  const requester = resolveCronAuthenticatedChannelRequester(job);
  const origin = resolveCronAuthenticatedCallerOrigin(job);
  return {
    agentId,
    ...(policy.mode === "account"
      ? {
          sessionKey: policy.ownerSessionKey,
          account: {
            id: policy.ownerAccountId,
            channel: origin?.kind === "external" ? origin.channel : requester?.channel,
          },
        }
      : {}),
    ...(requester
      ? {
          requester: {
            requesterSenderId: requester.senderId,
            messageChannel: requester.channel,
            agentAccountId: requester.accountId,
          },
        }
      : {}),
  };
}

function subscriptionIdentity(params: Record<string, unknown>) {
  const delivery = isRecord(params.delivery) ? params.delivery : undefined;
  if (
    typeof params.name !== "string" ||
    !params.name ||
    params.name.length > 256 ||
    !isRecord(params.arguments) ||
    delivery?.mode !== "webhook" ||
    typeof delivery.url !== "string" ||
    delivery.url.length > 4096
  ) {
    throw new Error("MCP Events requires an exact webhook subscription identity.");
  }
  const url = new URL(delivery.url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("MCP Events callback must be an HTTPS URL without credentials or a fragment.");
  }
  return {
    name: params.name,
    arguments: structuredClone(params.arguments),
    delivery: { mode: "webhook", url: delivery.url },
  };
}

function authorityDefinition(job: CronStoredJob) {
  return {
    schedule: job.schedule,
    agentId: job.agentId,
    sessionKey: job.sessionKey,
    owner: job.owner,
    toolsAllow: job.payload.toolsAllow,
    scheduledToolPolicy: job.scheduledToolPolicy,
    toolsAllowProvenance: job.toolsAllowProvenance,
    sourceIdentity: job.state.sourceIdentity,
  };
}

type PreparedConnection = Awaited<ReturnType<typeof prepareMcpEventConnection>>;
type Cleanup = {
  identity: ReturnType<typeof subscriptionIdentity>;
  selector: PreparedConnection["selector"];
  authorizationIdentity: string;
  endpoint: string;
  expiresAt: number;
};

export function createPluginServiceMcpEvents(params: {
  pluginId: string;
  lease: PluginRuntimeCapabilityLease;
  isStopping: () => boolean;
  getCron: () => PluginServiceCronHost | null | undefined;
  resolveGatewayContext?: GatewayContextResolver;
}): Capability {
  let sourceCount = 0;
  const runScheduled = createScheduledGatewayRunner(params.resolveGatewayContext);
  const assertService = (cleanupOnly = false) => {
    params.lease.assertActive("MCP Events");
    if (!cleanupOnly && params.isStopping()) {
      throw new Error("MCP Events service is unavailable.");
    }
  };
  const captureSource = (input: { jobId: string; sourceIdentity: string; serverName: string }) => {
    assertService();
    const context = params.resolveGatewayContext?.();
    const cron = params.getCron();
    const current = cron?.getJob(input.jobId);
    if (
      !context ||
      !current?.enabled ||
      current.schedule.kind !== "event" ||
      current.schedule.source !== params.pluginId ||
      current.state.sourceIdentity !== input.sourceIdentity ||
      current.schedule.options.server !== input.serverName
    ) {
      throw new Error("MCP Events source is no longer current.");
    }
    const job = structuredClone(current);
    const definition = authorityDefinition(job);
    const cfg = context.getRuntimeConfig();
    const registry = context.getGatewayMethodRegistry?.();
    const assertCurrent = () => {
      assertService();
      const next = cron?.getJob(input.jobId);
      if (
        params.resolveGatewayContext?.() !== context ||
        params.getCron() !== cron ||
        !next?.enabled ||
        !isDeepStrictEqual(definition, authorityDefinition(next)) ||
        context.getRuntimeConfig() !== cfg ||
        context.getGatewayMethodRegistry?.() !== registry
      ) {
        throw new Error("MCP Events creator authority or configuration changed.");
      }
    };
    return { job, cfg, principal: jobPrincipal(job), assertCurrent };
  };
  const opaque = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    prepareSource: (original) =>
      runScheduled(async () => {
        const input = { ...original };
        const prepare = async () => {
          const captured = captureSource(input);
          const connection = await prepareMcpEventConnection({
            ...captured,
            serverName: input.serverName,
          });
          return { captured, connection };
        };
        if (sourceCount >= MAX_PREPARED_SOURCES) {
          throw new Error("MCP Events source capability capacity reached.");
        }
        let current = await prepare();
        if (sourceCount >= MAX_PREPARED_SOURCES) {
          current.connection.release();
          throw new Error("MCP Events source capability capacity reached.");
        }
        sourceCount++;
        let active = true;
        let retired = false;
        let cleanup: Cleanup | undefined;
        let pending: Promise<unknown> | undefined;
        let revalidating: Promise<void> | undefined;
        const dispose = params.lease.retain(() => {
          active = false;
          current.connection.release();
          cleanup = undefined;
          sourceCount--;
        });
        const assertOpen = () => {
          if (!active) {
            throw new Error("MCP Events source capability was disposed.");
          }
          if (retired) {
            throw new McpConnectionAuthorityError("retired");
          }
          assertService();
        };
        const assertCurrent = () => {
          assertOpen();
          current.connection.assertCurrent();
        };
        const principalIdentity = ({ captured, connection }: typeof current) =>
          opaque([
            captured.principal,
            captured.job.scheduledToolPolicy,
            input.serverName,
            connection.configurationIdentity,
            connection.authorizationIdentity,
            connection.endpoint,
          ]);
        const principalId = principalIdentity(current);
        const accountId = opaque([
          current.captured.principal.agentId,
          current.captured.principal.account ?? current.captured.job.scheduledToolPolicy,
        ]);
        const revalidate = () => {
          revalidating ??= runScheduled(async () => {
            assertOpen();
            try {
              await current.connection.revalidate();
              assertCurrent();
            } catch (error) {
              if (error instanceof McpConnectionAuthorityError) {
                throw error;
              }
              // Only policy/session replacement may reacquire the same grant. Cleanup stays here.
              const next = await prepare();
              try {
                assertOpen();
                next.connection.assertCurrent();
                if (principalIdentity(next) !== principalId) {
                  retired = true;
                  throw new McpConnectionAuthorityError("retired");
                }
                current.connection.release();
                current = next;
              } finally {
                if (current !== next) {
                  next.connection.release();
                }
              }
            }
          })
            .catch((error: unknown) => {
              retired ||=
                !(error instanceof McpConnectionAuthorityError) ||
                error.code !== "MCP_AUTHORIZATION_UNAVAILABLE";
              throw error;
            })
            .finally(() => {
              revalidating = undefined;
            });
          return revalidating;
        };
        const execute = async (
          method: Parameters<typeof requestMcpEvent>[0]["method"],
          originalParams: Record<string, unknown>,
          signal: AbortSignal,
        ) => {
          const cleanupOnly = method === "events/unsubscribe";
          const previous = pending;
          if (cleanupOnly) {
            // No new subscribe can race cleanup; callback revalidation never waits on this work.
            retired = true;
          } else {
            assertCurrent();
            if (method === "events/subscribe" && pending) {
              throw new Error("MCP Events subscription request is already pending.");
            }
          }
          const requestParams = structuredClone(originalParams);
          const admitted = current;
          const context = params.resolveGatewayContext?.();
          const cron = params.getCron();
          const operation = runScheduled(async () => {
            if (cleanupOnly) {
              await previous?.catch(() => {});
            }
            const captured = cleanup;
            const assertRequest = () => {
              assertService(cleanupOnly);
              signal.throwIfAborted();
              if (
                !active ||
                !context ||
                params.resolveGatewayContext?.() !== context ||
                params.getCron() !== cron
              ) {
                throw new Error("MCP Events source capability was disposed or its host replaced.");
              }
              if (cleanupOnly) {
                if (!captured || cleanup !== captured || captured.expiresAt <= Date.now()) {
                  throw new Error(
                    "MCP Events cleanup has no captured subscription authority; its finite remote lease must expire.",
                  );
                }
              } else {
                assertOpen();
                admitted.connection.assertCurrent();
              }
            };
            assertRequest();
            const route = cleanupOnly ? captured! : admitted.connection;
            let wireParams: Record<string, unknown> = cleanupOnly
              ? captured!.identity
              : method === "events/list" && typeof requestParams.cursor === "string"
                ? { cursor: requestParams.cursor }
                : {};
            let expiresAt: number | undefined;
            if (method === "events/subscribe") {
              const identity = subscriptionIdentity(requestParams);
              const job = admitted.captured.job;
              if (
                job.schedule.kind !== "event" ||
                identity.name !== job.schedule.options.name ||
                !isDeepStrictEqual(identity.arguments, job.schedule.options.arguments ?? {})
              ) {
                throw new Error("MCP Events subscription does not match its persisted source.");
              }
              if (cleanup && !isDeepStrictEqual(cleanup.identity, identity)) {
                throw new Error(
                  "MCP Events prepared source already owns another webhook subscription.",
                );
              }
              const ttlMs = requestParams.ttlMs;
              const delivery = isRecord(requestParams.delivery)
                ? requestParams.delivery
                : undefined;
              if (
                typeof ttlMs !== "number" ||
                !Number.isSafeInteger(ttlMs) ||
                ttlMs <= 0 ||
                ttlMs > MAX_SUBSCRIPTION_TTL_MS ||
                typeof delivery?.secret !== "string" ||
                delivery.secret.length > 1024 ||
                !delivery.secret.startsWith("whsec_")
              ) {
                throw new Error(
                  "MCP Events requires a signing secret and a finite TTL of at most one hour.",
                );
              }
              registerSecretValueForRedaction(delivery.secret);
              registerSecretValueForRedaction(delivery.secret.slice("whsec_".length));
              // Capture before transport: failure cannot establish whether upstream subscribed.
              expiresAt = Date.now() + ttlMs + CLEANUP_GRACE_MS;
              cleanup = {
                identity,
                selector: route.selector,
                authorizationIdentity: route.authorizationIdentity,
                endpoint: route.endpoint,
                expiresAt,
              };
              wireParams = {
                ...identity,
                delivery: { ...identity.delivery, secret: delivery.secret },
                ttlMs,
                ...(requestParams.cursor !== undefined ? { cursor: requestParams.cursor } : {}),
              };
            }
            // Resolver headers/URLs are snapshots; acquire fresh material under the same grant.
            const connection = await prepareMcpEventCredentialConnection(
              route.selector,
              assertRequest,
            );
            try {
              if (
                connection.authorizationIdentity !== route.authorizationIdentity ||
                connection.endpoint !== route.endpoint
              ) {
                retired = true;
                throw new McpConnectionAuthorityError("retired");
              }
              const result = await requestMcpEvent({
                ...connection,
                serverName: input.serverName,
                method,
                params: wireParams,
                signal,
                assertCurrent: connection.assertCurrent,
              });
              connection.assertCurrent();
              if (expiresAt !== undefined) {
                const refreshBefore =
                  isRecord(result) && typeof result.refreshBefore === "string"
                    ? Date.parse(result.refreshBefore)
                    : Number.NaN;
                if (
                  !Number.isFinite(refreshBefore) ||
                  refreshBefore <= Date.now() ||
                  refreshBefore > expiresAt
                ) {
                  throw new Error(
                    "MCP Events server did not confirm a bounded subscription lease; remote outcome is unknown.",
                  );
                }
              }
              if (cleanupOnly) {
                cleanup = undefined;
              }
              return result;
            } finally {
              connection.release();
            }
          });
          if (cleanupOnly || method === "events/subscribe") {
            pending = operation;
          }
          try {
            return await operation;
          } finally {
            if (pending === operation) {
              pending = undefined;
            }
          }
        };
        try {
          assertCurrent();
          return {
            accountId,
            principalId,
            assertCurrent,
            revalidate,
            dispose,
            request: async (method, requestParams, signal) => {
              if (!["server/discover", "events/list", "events/subscribe"].includes(method)) {
                throw new Error("Unsupported MCP Events method.");
              }
              return await execute(method, requestParams, signal);
            },
            unsubscribe: (signal) => execute("events/unsubscribe", {}, signal),
          };
        } catch (error) {
          dispose();
          throw error;
        }
      }),
  };
}
