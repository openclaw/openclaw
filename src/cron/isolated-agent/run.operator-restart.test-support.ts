import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureGatewayAuthPolicy } from "../../gateway/auth-policy.js";
import { resolveGatewayAuthForConfig } from "../../gateway/auth-resolve.js";
import * as cronSourceRuntime from "../../gateway/cron-operator-source.js";
import * as operatorCapture from "../../gateway/operator-run-authority.js";
import { createGatewayControlUiIngressFactory } from "../../gateway/remote-control-ui-ingress.js";
import { registerIngressPrincipalRecovery } from "../../gateway/remote-ingress-principal-recovery.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { createOperatorClient } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { recordSessionOperatorSource } from "../../gateway/session-operator-sources.js";
import { prepareSessionSystemTurnAuthority } from "../../gateway/session-system-turn-authority.js";
import type { GatewayIngressPrincipalBindingV1 } from "../../plugins/gateway-ingress.types.js";
import type { CronStoredJob } from "../types.js";

export async function prepareRestartBeforeScheduling(params: {
  original: { authority: AdmittedRunOperatorAuthority; release(): void };
  target: { agentId: string; sessionKey: string; sessionId: string; storePath: string };
  context: GatewayRequestContext;
  profile: { id: string };
  readJobs: () => Promise<unknown[]>;
  revoked: boolean;
  sourceLess: boolean;
}): Promise<boolean> {
  const { original, target, context, profile, readJobs, revoked, sourceLess } = params;
  const initiating = original;
  const service = new AbortController();
  let ingressPermitted = true;
  registerIngressPrincipalRecovery(context, "mcp-relay", {
    signal: service.signal,
    assertCurrent: () => service.signal.throwIfAborted(),
    resume: async (audienceId) =>
      ingressPermitted
        ? {
            audienceId,
            recoveryId: "0",
            principal: { kind: "person", profileId: profile.id },
            operatorScopeCeiling: ["operator.read", "operator.write"],
            signal: service.signal,
            assertCurrent: () => {
              service.signal.throwIfAborted();
              if (!ingressPermitted) {
                throw new Error("Original ingress grant revoked");
              }
            },
          }
        : undefined,
  });
  if (!sourceLess) {
    await recordSessionOperatorSource({
      ...target,
      authority: initiating.authority,
      log: { warn() {} },
    });
    expect(
      (await readSessionEntryReadOnlyInWorker(target))?.operatorSources?.[profile.id]
        ?.sourceIngress,
    ).toBe("principal");
  }
  // The initiating request is gone before restart admission reconstructs the
  // next model turn. No schedule exists yet and no human follow-up is supplied.
  initiating.release();
  expect(() => initiating.authority.assertCurrent()).toThrow();
  if (revoked) {
    ingressPermitted = false;
    await expect(
      prepareSessionSystemTurnAuthority({ ...target, context, preserveRecordedSource: true }),
    ).rejects.toThrow(/ingress|authority|grant/i);
    expect(await readJobs()).toEqual([]);
    service.abort();
    return false;
  }
  const resumed = expectDefined(
    await prepareSessionSystemTurnAuthority({ ...target, context, preserveRecordedSource: true }),
    "reconstructed system turn",
  );
  expect(resumed.authority?.scopes).toContain("operator.write");
  if (sourceLess) {
    expect(resumed.authority?.recoverySnapshot).toBeUndefined();
    expect(await readJobs()).toEqual([]);
    resumed.release();
    service.abort();
    return false;
  }
  expect(resumed.authority?.recoverySnapshot?.sourceIngress).toBe("principal");
  initiating.authority = expectDefined(resumed.authority, "resumed operator authority");
  initiating.release = () => {
    resumed.release();
    service.abort();
  };

  return true;
}

/** A real principal request captures its own source; no recovery snapshot is fabricated. */
export async function captureRealIngressOperator(params: {
  context: GatewayRequestContext;
  config: OpenClawConfig;
  profileId: string;
  scopes: string[];
}) {
  const lifetime = new AbortController();
  const factory = principalIngressFactory(params.context, lifetime.signal, "mcp-relay");
  const grant = {
    audienceId: "continuation-grant",
    recoveryId: "0",
    principal: { kind: "person" as const, profileId: params.profileId },
    operatorScopeCeiling: params.scopes,
    signal: lifetime.signal,
    assertCurrent: () => lifetime.signal.throwIfAborted(),
  };
  await factory.registerPrincipalRecovery?.(async (audienceId) =>
    audienceId === grant.audienceId ? grant : undefined,
  );
  const capture = operatorCapture.captureGatewayOperatorRunAuthority;
  let retained: { authority: AdmittedRunOperatorAuthority; release(): void } | undefined;
  const observe = vi
    .spyOn(operatorCapture, "captureGatewayOperatorRunAuthority")
    .mockImplementation(async (input) => {
      const result = await capture(input);
      if (input.client?.internal?.remoteIngressPrincipal && result) {
        expect(input.client.authPolicy).toBeUndefined();
        const release = result.authority.retain?.();
        retained = {
          authority: result.authority,
          release: () => {
            release?.();
            lifetime.abort();
          },
        };
      }
      return result;
    });
  try {
    const binding = await factory.bindPrincipal(grant);
    await binding.request("voicewake.get", {});
    const source = expectDefined(retained, "source captured by real ingress RPC");
    expect(source.authority.recoverySnapshot?.sourceIngress).toBe("principal");
    return source;
  } catch (error) {
    retained?.release();
    lifetime.abort();
    throw error;
  } finally {
    observe.mockRestore();
  }
}

/** Lower-level revocation fixtures; positive restart/scheduling paths use the real ingress owner. */
export function principalRecoveryFixture(
  authority: AdmittedRunOperatorAuthority,
  accessRevoked: boolean,
) {
  const captured = expectDefined(authority.recoverySnapshot, "creator recovery source");
  const {
    authPolicy: _auth,
    sharedGeneration: _generation,
    device: _device,
    ...snapshot
  } = captured;
  return createAdmittedRunOperatorAuthority({
    ...authority,
    recoverySnapshot: {
      ...snapshot,
      sourceIngress: "principal",
      grant: accessRevoked
        ? { pluginId: "principal-access", grantId: "original-grant" }
        : snapshot.grant,
      ingress: { pluginId: "mcp-relay", audienceId: "continuation-grant", recoveryId: "0" },
      controlUiAdmin: false,
      localOperator: false,
    },
  });
}

/** Each occurrence rehydrates the consent owner separately from the initiating request. */
export function registerScheduledPrincipalFixture(params: {
  context: GatewayRequestContext;
  profileId: string;
  scopes: string[];
  state: "current" | "revoked" | "replaced" | "owner-unavailable" | "store-unavailable";
}) {
  const service = new AbortController();
  const permitted = params.state !== "revoked";
  let available = params.state !== "store-unavailable";
  const register = () =>
    registerIngressPrincipalRecovery(params.context, "mcp-relay", {
      signal: service.signal,
      assertCurrent: () => service.signal.throwIfAborted(),
      resume: async (audienceId) => {
        if (!available) {
          throw new Error("Canonical consent store is temporarily unavailable");
        }
        return permitted
          ? {
              audienceId,
              recoveryId: params.state === "replaced" ? "1" : "0",
              principal: { kind: "person", profileId: params.profileId },
              operatorScopeCeiling: params.scopes,
              signal: service.signal,
              assertCurrent: () => service.signal.throwIfAborted(),
            }
          : undefined;
      },
    });
  if (params.state !== "owner-unavailable") {
    register();
  }
  return {
    restore: () => {
      available = true;
      register();
    },
    release: () => service.abort(),
  };
}

export function expectRetryableOriginalOneShot(
  job: CronStoredJob,
  jobId: string,
  now: number,
): number {
  expect(job.id).toBe(jobId);
  expect(job.enabled, job.state.lastError).toBe(true);
  expect(job.state.autoDisabled).toBeUndefined();
  expect(job.state.lastRunStatus).toBe("error");
  const next = expectDefined(job.state.nextRunAtMs, "rearmed original occurrence");
  expect(next).toBeGreaterThan(now);
  return next;
}

export function principalGatewayPolicy(
  allowlisted = false,
): NonNullable<OpenClawConfig["gateway"]> {
  return {
    roles: {
      default: "writer",
      definitions: {
        writer: {
          scopes: ["operator.read", "operator.write"],
          agents: "*",
          sessions: { others: "none" },
        },
      },
    },
    auth: {
      mode: "trusted-proxy",
      token: "principal-policy-test-token",
      trustedProxy: {
        userHeader: "cf-access-authenticated-user-email",
        requiredHeaders: ["cf-access-jwt-assertion"],
        ...(allowlisted ? { allowUsers: ["scheduled-operator@example.test"] } : {}),
      },
    },
  };
}

function bindPersonPolicyRevocation(
  context: GatewayRequestContext,
  config: OpenClawConfig,
  profileId: string,
  scopes: string[],
  scenario: string,
) {
  let current = config;
  context.getRuntimeConfig = () => current;
  context.getCommittedRuntimeConfig = () => current;
  return async () => {
    const disableMode = scenario.startsWith("principal auth mode");
    const lifetime = new AbortController();
    let live: GatewayIngressPrincipalBindingV1 | undefined;
    try {
      if (disableMode) {
        live = await principalIngressFactory(
          context,
          lifetime.signal,
          "policy-control",
        ).bindPrincipal({
          audienceId: "live-policy-control",
          principal: { kind: "person", profileId },
          operatorScopeCeiling: scopes,
          signal: lifetime.signal,
          assertCurrent: () => lifetime.signal.throwIfAborted(),
        });
      }
      current = {
        ...config,
        gateway: {
          ...config.gateway,
          auth: {
            ...config.gateway?.auth,
            ...(disableMode
              ? { mode: "token" as const }
              : {
                  trustedProxy: {
                    ...config.gateway?.auth?.trustedProxy,
                    userHeader: "cf-access-authenticated-user-email",
                    allowUsers: ["other-person@example.test"],
                  },
                }),
          },
        },
      };
      setRuntimeConfigSnapshot(current);
      if (live) {
        await expect(live.request("voicewake.get", {})).rejects.toMatchObject({
          code: "unsupported-auth",
        });
      }
    } finally {
      await live?.close();
      lifetime.abort();
    }
  };
}

export function revokeAfterNextPrincipalRestore(revoke: () => void | Promise<void>) {
  const restore = cronSourceRuntime.restoreCronOperatorSource;
  vi.spyOn(cronSourceRuntime, "restoreCronOperatorSource").mockImplementationOnce(
    async (params) => {
      const actual = await restore(params);
      expect(actual?.authority.recoverySnapshot?.sourceIngress).toBe("principal");
      await revoke();
      return actual;
    },
  );
}

/** Shared synthetic caller I/O; the principal source itself is still captured by real ingress. */
export function prepareContinuationClient(params: {
  config: OpenClawConfig;
  context: GatewayRequestContext;
  profileId: string;
  scenario: string;
}) {
  const { config, context, profileId, scenario } = params;
  const client = createOperatorClient({
    profileId,
    scopes: scenario.startsWith("restart before scheduling")
      ? ["operator.read", "operator.write"]
      : scenario === "guest"
        ? ["operator.sessions.write"]
        : scenario === "write-scoped operator"
          ? ["operator.write"]
          : scenario === "cron-scoped operator"
            ? ["operator.sessions.write", "operator.cron"]
            : ["operator.admin"],
  });
  client.connect.client.id = "openclaw-control-ui";
  client.connect.client.mode = "webchat";
  client.internal = {
    authenticatedOperator: true,
    ...(client.connect.scopes?.includes("operator.admin") ? { controlUiAdmin: true } : {}),
  };
  client.authPolicy = captureGatewayAuthPolicy(config, { role: "operator", authMethod: "token" });
  context.getRuntimeConfig = () => config;
  const revokePersonPolicy = isPrincipalPolicyScenario(scenario)
    ? bindPersonPolicyRevocation(context, config, profileId, client.connect.scopes ?? [], scenario)
    : undefined;
  return { client, revokePersonPolicy };
}

function principalIngressFactory(
  context: GatewayRequestContext,
  signal: AbortSignal,
  pluginId: string,
) {
  const getConfig = () => context.getCommittedRuntimeConfig?.() ?? context.getRuntimeConfig();
  return createGatewayControlUiIngressFactory({
    pluginId,
    signal,
    assertCurrent: () => signal.throwIfAborted(),
    host: {
      signal,
      controlUiBasePath: "",
      getRuntimeConfig: getConfig,
      getResolvedAuth: () => resolveGatewayAuthForConfig({ config: getConfig(), env: {} }),
      resolveGatewayContext: () => context,
      handleRequest: async () => {
        throw new Error("This proof uses principal RPC, not HTTP presentation.");
      },
      handleSandboxRequest: async () => {
        throw new Error("This proof uses principal RPC, not sandbox presentation.");
      },
      handleUpgrade: async () => {
        throw new Error("This proof uses principal RPC, not WebSocket presentation.");
      },
    },
  });
}

export const PRINCIPAL_POLICY_CASES = [
  "principal allowlist allowed",
  "principal allowlist removed before restore",
  "principal allowlist removed before effect",
  "principal auth mode disabled before restore",
  "principal auth mode disabled before effect",
] as const;
export const isPrincipalPolicyScenario = (scenario: string) =>
  PRINCIPAL_POLICY_CASES.some((value) => value === scenario);

export async function preparePrincipalPolicyChange(
  scenario: string,
  revoke: (() => void | Promise<void>) | undefined,
) {
  if (!revoke) {
    return;
  }
  if (scenario.endsWith("before restore")) {
    await revoke();
  } else if (scenario.endsWith("before effect")) {
    revokeAfterNextPrincipalRestore(revoke);
  }
}
