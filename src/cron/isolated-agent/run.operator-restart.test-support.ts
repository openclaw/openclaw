import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as operatorCapture from "../../gateway/operator-run-authority.js";
import { createGatewayControlUiIngressFactory } from "../../gateway/remote-control-ui-ingress.js";
import { registerIngressPrincipalRecovery } from "../../gateway/remote-ingress-principal-recovery.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { recordSessionOperatorSource } from "../../gateway/session-operator-sources.js";
import { prepareSessionSystemTurnAuthority } from "../../gateway/session-system-turn-authority.js";
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
  const factory = createGatewayControlUiIngressFactory({
    pluginId: "mcp-relay",
    signal: lifetime.signal,
    assertCurrent: () => lifetime.signal.throwIfAborted(),
    host: {
      signal: lifetime.signal,
      controlUiBasePath: "",
      getRuntimeConfig: () => params.config,
      getResolvedAuth: () => ({
        mode: "trusted-proxy",
        allowTailscale: false,
        trustedProxy: {
          userHeader: "cf-access-authenticated-user-email",
          requiredHeaders: ["cf-access-jwt-assertion"],
        },
      }),
      resolveGatewayContext: () => params.context,
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
