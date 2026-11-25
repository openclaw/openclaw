import { randomUUID, X509Certificate } from "node:crypto";
import { expect } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { ExecApprovalRecord } from "./exec-approval-manager.js";
import { getOperatorApprovalDetailed } from "./operator-approval-store.js";
import type { OperatorScope } from "./operator-scopes.js";
import { connectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { kernelGatewayTestStateOptions } from "./test-helpers.env.js";

export type MatrixClient = Awaited<ReturnType<typeof connectGatewayClient>>;
export const reviewScopes: OperatorScope[] = [
  "operator.read",
  "operator.write",
  "operator.approvals",
];
export const actors = [
  { name: "creator", cap: "invited", scopes: reviewScopes, member: false },
  { name: "admin", cap: "write", scopes: ["operator.admin"] as OperatorScope[], member: false },
  { name: "team-view", cap: "view", scopes: reviewScopes, member: false },
  { name: "team-suggest", cap: "suggest", scopes: reviewScopes, member: false },
  { name: "team-write", cap: "write", scopes: reviewScopes, member: false },
  { name: "team-view-member", cap: "view", scopes: reviewScopes, member: true },
  { name: "team-suggest-member", cap: "suggest", scopes: reviewScopes, member: true },
  {
    name: "invited-write",
    cap: "invited",
    scopes: ["operator.read", "operator.write"] as OperatorScope[],
    member: true,
  },
  {
    name: "invited-approvals",
    cap: "invited",
    scopes: ["operator.read", "operator.approvals"] as OperatorScope[],
    member: true,
  },
  { name: "invited-both", cap: "invited", scopes: reviewScopes, member: true },
] as const;

export async function withMatrixGateway(
  signal: AbortSignal,
  namedRoles: boolean,
  run: (fixture: {
    admin: MatrixClient;
    connect: (
      name: string,
      scopes: OperatorScope[],
      ios?: boolean,
    ) => Promise<{ client: MatrixClient; deviceId: string }>;
    profiles: Map<string, string>;
    state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  }) => Promise<void>,
) {
  await using cleanup = new AsyncDisposableStack();
  const state = await createOpenClawTestState({
    ...kernelGatewayTestStateOptions("invite-scope-matrix"),
    prepareProfileCatalog: true,
  });
  cleanup.defer(() => state.cleanup());
  const profiles = new Map<string, string>();
  const email = (name: string) => `${name}@invite-matrix.example.test`;
  for (const actor of actors) {
    const profile = ensureProfileForEmail(email(actor.name));
    setUserProfileRole(profile.id, actor.name);
    profiles.set(actor.name, profile.id);
  }
  const certPath = await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM);
  const keyPath = await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM);
  const tlsFingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
  const origin = "https://invite-matrix.example.test";
  const headers = (name: string) => ({
    "x-forwarded-user": email(name),
    "x-forwarded-for": "203.0.113.50",
    "x-forwarded-proto": "https",
  });
  const token = "invite-matrix-isolated-token";
  const auth: NonNullable<OpenClawConfig["gateway"]>["auth"] = namedRoles
    ? {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto"],
          allowUsers: actors.map((actor) => email(actor.name)),
          allowLoopback: true,
          deviceAutoApprove: { enabled: true, scopes: ["operator.admin", ...reviewScopes] },
        },
        identityScopes: Object.fromEntries(
          actors.map((actor) => [email(actor.name), [...actor.scopes]]),
        ),
      }
    : { mode: "token", token };
  const gateway = await startGatewayWithClient({
    configPath: state.configPath,
    auth,
    token: namedRoles ? undefined : token,
    secure: true,
    tlsFingerprint,
    origin,
    edgeAuthHeaders: namedRoles ? headers("admin") : undefined,
    clientName: "openclaw-control-ui",
    mode: "webchat",
    scopes: ["operator.admin"],
    cfg: {
      agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } },
      plugins: { slots: { memory: "none" } },
      gateway: {
        auth,
        tls: { enabled: true, autoGenerate: false, certPath, keyPath },
        trustedProxies: ["127.0.0.1", "::1"],
        controlUi: { allowedOrigins: [origin] },
        ...(namedRoles
          ? {
              roles: {
                default: "admin",
                definitions: Object.fromEntries(
                  actors.map((actor) => [
                    actor.name,
                    {
                      agents: "*",
                      scopes: [...actor.scopes],
                      sessions: { others: actor.cap },
                    },
                  ]),
                ),
              },
            }
          : {}),
      },
    },
  });
  cleanup.defer(() => gateway.server.close({ reason: "invite scope matrix cleanup" }));
  cleanup.defer(() => gateway.client.stopAndWait());
  const connect = async (name: string, scopes: OperatorScope[], ios = false) => {
    const identity = loadOrCreateDeviceIdentity({
      path: state.path(name, "client", "credentials.sqlite"),
    });
    if (ios) {
      const pairing = await requestDevicePairing({
        deviceId: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        clientId: "openclaw-ios",
        clientMode: "ui",
        platform: "ios",
        role: "operator",
        scopes,
        silent: false,
      });
      await gateway.client.request("device.pair.approve", { requestId: pairing.request.requestId });
    }
    const client = await connectGatewayClient({
      signal,
      url: `wss://127.0.0.1:${gateway.port}`,
      tlsFingerprint,
      origin,
      edgeAuthHeaders: namedRoles ? headers(name) : undefined,
      token: namedRoles ? undefined : token,
      clientName: ios ? "openclaw-ios" : "openclaw-control-ui",
      mode: ios ? "ui" : "webchat",
      platform: ios ? "ios" : undefined,
      scopes,
      caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
      deviceIdentity: identity,
    });
    cleanup.defer(() => client.stopAndWait());
    return { client, deviceId: identity.deviceId };
  };
  await run({ admin: gateway.client, connect, profiles, state });
}

export async function requestMatrixApproval(
  client: MatrixClient,
  sessionKey?: string,
  node = false,
) {
  const id = randomUUID();
  const request = {
    command: "printf invite-matrix",
    host: node ? "node" : "gateway",
    agentId: "main",
    ...(sessionKey ? { sessionKey } : {}),
  };
  await client.request("exec.approval.request", {
    id,
    ...request,
    twoPhase: true,
    requireDeliveryRoute: false,
    timeoutMs: 120_000,
    ...(node
      ? {
          nodeId: "matrix-node",
          commandArgv: ["printf", "invite-matrix"],
          systemRunPlan: {
            argv: ["printf", "invite-matrix"],
            cwd: null,
            commandText: request.command,
            agentId: "main",
            sessionKey: null,
          },
        }
      : {}),
  });
  const durable = await getOperatorApprovalDetailed({ id });
  expect(durable.outcome).toBe("found");
  if (durable.outcome !== "found") {
    throw new Error("approval registration did not persist");
  }
  const record: ExecApprovalRecord<unknown> = {
    id,
    request,
    createdAtMs: durable.record.createdAtMs,
    expiresAtMs: durable.record.expiresAtMs,
    requestedByProfileId: durable.record.requester.profileId,
    requestedByDeviceId: durable.record.requester.deviceId,
    requestedByClientId: durable.record.requester.clientId,
    approvalReviewerDeviceIds: durable.record.reviewerDeviceIds,
  };
  return record;
}

export function matrixChecks() {
  const cells: Array<{
    row: string;
    column: string;
    mainExpected: boolean;
    correctedExpected: boolean;
    actual: boolean;
    error?: string;
  }> = [];
  return {
    async check(
      row: string,
      column: string,
      mainExpected: boolean,
      correctedExpected: boolean,
      action: () => Promise<unknown>,
    ) {
      let actual = false,
        error: string | undefined;
      try {
        const result = await action();
        actual = typeof result === "boolean" ? result : true;
      } catch (caught) {
        error = String(caught);
      }
      cells.push({
        row,
        column,
        mainExpected,
        correctedExpected,
        actual,
        ...(error ? { error } : {}),
      });
      expect
        .soft(
          actual,
          `${row} / ${column}: main=${mainExpected}, corrected=${correctedExpected}${error ? `; ${error}` : ""}`,
        )
        .toBe(correctedExpected);
      return actual;
    },
    report() {
      console.log("INVITE_SCOPE_MATRIX " + JSON.stringify(cells));
    },
  };
}
