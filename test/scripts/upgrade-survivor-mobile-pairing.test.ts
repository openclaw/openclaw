import { createHash, createPublicKey, verify } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import {
  MOBILE_PAIRING_AUDIT_CLIENT,
  MOBILE_PAIRING_APPROVAL_SCOPES,
  MOBILE_PAIRING_CLIENT,
  MOBILE_PAIRING_NODE_CAPS,
  MOBILE_PAIRING_NODE_COMMANDS,
  MOBILE_PAIRING_NODE_PERMISSIONS,
  MOBILE_PAIRING_OPERATOR_CAPS,
  approveBaselineNodePairing,
  assertGatewayHealth,
  attemptConnect,
  buildConnectRequest,
  buildDeviceAuthCompatibilityPayloadV2,
  buildRedactedEvidence,
  createMobilePairingIdentity,
  extractBootstrapCredentials,
  inspectBaselineNodePairing,
  parseConnectChallengePayload,
  parseQrBootstrapJson,
  persistHelloCredential,
  validatePairingAudit,
} from "../../scripts/e2e/lib/upgrade-survivor/mobile-pairing-client.mts";
import { runProcess } from "./upgrade-survivor-shard.test-support.js";

const cleanPairing = {
  pendingDevicePairingCount: 0,
  pendingNodePairingCount: 0,
  pairedDevicePresent: true,
  pairedNodePresent: true,
  nodeSurfaceReapprovalRequired: false,
  nodeSurfaceCommandAdditions: [],
} satisfies Parameters<typeof buildRedactedEvidence>[0]["pairing"];

afterEach(() => vi.useRealTimers());

function tokenEvidence(used: string, stored = used) {
  return {
    usedTokenHash: createHash("sha256").update(used).digest("hex"),
    storedTokenHash: createHash("sha256").update(stored).digest("hex"),
    deviceTokenReturned: true,
    tokenRotated: used !== stored,
  };
}

const operatorScopes = [
  "operator.approvals",
  "operator.read",
  "operator.talk.secrets",
  "operator.write",
];
function credentialsFor(nodeToken: string, operatorToken: string, url = "ws://127.0.0.1:18789") {
  return extractBootstrapCredentials({
    url,
    client: MOBILE_PAIRING_CLIENT,
    identity: createMobilePairingIdentity(),
    hello: {
      type: "hello-ok",
      auth: {
        ...roleAuth("node", nodeToken, []),
        deviceTokens: [{ ...roleAuth("operator", operatorToken, operatorScopes), issuedAtMs: 1 }],
      },
    },
  });
}

function roleAuth(role: "node" | "operator", deviceToken: string, scopes: string[]) {
  return { role, deviceToken, scopes };
}

function persistToken(
  credentials: ReturnType<typeof credentialsFor>,
  role: "node" | "operator",
  deviceToken: string,
) {
  return persistHelloCredential({
    credentials,
    role,
    hello: { type: "hello-ok", auth: roleAuth(role, deviceToken, credentials[role].scopes) },
  });
}

it.each([
  ["response", "Gateway response timed out"],
  ["open", "Gateway WebSocket open failed"],
  ["send", "fixture send failed"],
])("closes the WebSocket and releases waiters after %s failure", async (stage, error) => {
  vi.useFakeTimers();
  class FailureSocket extends EventEmitter {
    static CLOSED = 3;
    static instances: FailureSocket[] = [];
    readyState = 0;
    closeCalls = 0;

    constructor(_url: string) {
      super();
      FailureSocket.instances.push(this);
      queueMicrotask(() => {
        if (stage === "open") {
          this.emit("error", new Error("connect ECONNREFUSED"));
          return;
        }
        this.readyState = 1;
        this.emit("open");
        this.emit(
          "message",
          JSON.stringify({
            type: "event",
            event: "connect.challenge",
            payload: { nonce: "nonce-timeout", ts: 1_700_000_000_000 },
          }),
        );
      });
    }

    send(_value: string): void {
      if (stage === "send") {
        throw new Error("fixture send failed");
      }
    }

    close(): void {
      this.closeCalls += 1;
      this.readyState = FailureSocket.CLOSED;
      this.emit("close", 1000);
    }
  }

  const connectAttempt = expect(
    attemptConnect({
      WebSocket: FailureSocket,
      url: "ws://127.0.0.1:18789",
      client: MOBILE_PAIRING_CLIENT,
      mode: "node",
      role: "node",
      scopes: [],
    }),
  ).rejects.toThrow(error);
  await vi.advanceTimersByTimeAsync(stage === "response" ? 15_000 : 0);
  await connectAttempt;

  expect(FailureSocket.instances).toMatchObject([
    { closeCalls: 1, readyState: FailureSocket.CLOSED },
  ]);
  expect(FailureSocket.instances[0]?.listenerCount("message")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("requires the Gateway health RPC to report ok", () => {
  expect(() => assertGatewayHealth({ ok: true })).not.toThrow();
  expect(() => assertGatewayHealth({ ok: false })).toThrow(/health response invalid/);
  expect(() => assertGatewayHealth({})).toThrow(/health response invalid/);
});

it("uses shipped protocol ranges, challenge time, instance id, and auth.token", () => {
  const identity = createMobilePairingIdentity();
  const challengePayload = { nonce: " nonce-1 ", ts: 1_700_000_000_001 };
  const common = { challengePayload, client: MOBILE_PAIRING_CLIENT, identity };
  const nodeParams = buildConnectRequest({
    ...common,
    id: "connect-1",
    mode: "node",
    role: "node",
    scopes: [],
    auth: { token: "node-token" },
  }).params as { device: { signature: string } };
  const operatorParams = buildConnectRequest({
    ...common,
    id: "connect-2",
    mode: "ui",
    role: "operator",
    scopes: ["operator.read"],
    auth: { token: "operator-token" },
  }).params;
  const payload = buildDeviceAuthCompatibilityPayloadV2({
    deviceId: identity.deviceId,
    clientId: MOBILE_PAIRING_CLIENT.id,
    clientMode: "node",
    role: "node",
    scopes: [],
    signedAtMs: challengePayload.ts,
    token: "node-token",
    nonce: "nonce-1",
  });

  expect(payload).toBe(
    `v2|${identity.deviceId}|openclaw-ios|node|node||1700000000001|node-token|nonce-1`,
  );
  expect(nodeParams).toMatchObject({
    minProtocol: 3,
    maxProtocol: 4,
    client: { instanceId: MOBILE_PAIRING_CLIENT.instanceId },
    caps: MOBILE_PAIRING_NODE_CAPS,
    commands: MOBILE_PAIRING_NODE_COMMANDS,
    permissions: MOBILE_PAIRING_NODE_PERMISSIONS,
    locale: "en-US",
    userAgent: "Version 26.6.1",
    auth: { token: "node-token" },
    device: { nonce: "nonce-1", signedAt: challengePayload.ts },
  });
  expect(operatorParams).toMatchObject({
    minProtocol: 4,
    maxProtocol: 4,
    caps: ["inline-widgets"],
    auth: { token: "operator-token" },
  });
  expect(MOBILE_PAIRING_OPERATOR_CAPS).toEqual(["inline-widgets"]);
  expect(operatorParams).not.toHaveProperty("commands");
  expect(operatorParams).not.toHaveProperty("permissions");
  expect(nodeParams).not.toHaveProperty("auth.deviceToken");
  expect(operatorParams).not.toHaveProperty("auth.deviceToken");
  expect(
    verify(
      null,
      Buffer.from(payload),
      createPublicKey(identity.publicKeyPem),
      Buffer.from(nodeParams.device.signature, "base64url"),
    ),
  ).toBe(true);
});

it("requires the connect.challenge timestamp used by the shipped client", () => {
  expect(parseConnectChallengePayload({ nonce: " nonce-1 ", ts: 1_700_000_000_123 })).toEqual({
    nonce: "nonce-1",
    issuedAtMs: 1_700_000_000_123,
  });
  for (const payload of [
    null,
    { nonce: "nonce-1" },
    { nonce: "nonce-1", ts: "1700000000123" },
    { nonce: "nonce-1", ts: -1 },
    { nonce: "nonce-1", ts: 1.5 },
    { nonce: " ", ts: 1_700_000_000_123 },
  ]) {
    expect(() => parseConnectChallengePayload(payload)).toThrow(/Gateway challenge/);
  }
});

it("parses the QR bootstrap and extracts both baseline-issued role credentials", () => {
  const nodeToken = "node-token-secret";
  const operatorToken = "operator-token-secret";
  const setupCode = Buffer.from(
    JSON.stringify({
      url: "ws://127.0.0.1:18789",
      bootstrapToken: "bootstrap-token-secret",
    }),
  ).toString("base64url");
  const bootstrap = parseQrBootstrapJson({ setupCode });
  const credentials = credentialsFor(nodeToken, operatorToken, bootstrap.url);

  expect(bootstrap).toEqual({
    url: "ws://127.0.0.1:18789",
    bootstrapToken: "bootstrap-token-secret",
  });
  expect({ node: credentials.node, operator: credentials.operator }).toEqual({
    node: { token: nodeToken, scopes: [] },
    operator: { token: operatorToken, scopes: operatorScopes },
  });
  expect(credentials.client.instanceId).toBe(MOBILE_PAIRING_CLIENT.instanceId);
  expect(credentials.operator.scopes).not.toContain("operator.pairing");
  expect(credentials.operator.scopes).not.toContain("operator.admin");
});

it("accepts only the known node authority expansion for the mobile identity", () => {
  const pairedNode = {
    nodeId: "device-1",
    commands: ["camera.snap"],
    caps: ["camera"],
    permissions: { camera: false, screenRecording: true },
  };
  const pendingNode = {
    ...pairedNode,
    commands: ["watch.status", "camera.snap", "watch.notify"],
  };
  const audit = (pending: unknown[], expectKnownNodeSurfaceUpgrade = true) =>
    validatePairingAudit({
      devicePairing: { pending: [], paired: [{ deviceId: "device-1" }] },
      nodePairing: { pending, paired: [pairedNode] },
      deviceId: "device-1",
      expectKnownNodeSurfaceUpgrade,
    });
  expect(audit([], false)).toEqual(cleanPairing);
  expect(audit([pendingNode])).toEqual({
    ...cleanPairing,
    pendingNodePairingCount: 1,
    nodeSurfaceReapprovalRequired: true,
    nodeSurfaceCommandAdditions: ["watch.notify", "watch.status"],
  });
  expect(() => audit([pendingNode], false)).toThrow(/unexpected pending request/);
  for (const invalidPending of [
    { ...pendingNode, nodeId: "device-2" },
    { ...pendingNode, commands: ["camera.snap", "watch.status"] },
    { ...pendingNode, caps: ["camera", "microphone"] },
    { ...pendingNode, permissions: { camera: true, screenRecording: true } },
  ]) {
    expect(() => audit([invalidPending])).toThrow();
  }
  for (const narrowedPending of [
    { ...pendingNode, commands: ["watch.notify", "watch.status"] },
    { ...pendingNode, caps: [] },
    { ...pendingNode, permissions: { camera: false } },
  ]) {
    expect(() => audit([narrowedPending])).not.toThrow();
  }
  expect(() => audit([pendingNode, pendingNode])).toThrow(/unexpected pending request/);
  expect(() => audit([])).toThrow(/omitted the expected command-surface reapproval/);
});

it("completes legacy baseline node pairing only for the bootstrapped identity", async () => {
  const approvalRequest = buildConnectRequest({
    challengePayload: { nonce: "nonce-approval", ts: 1_700_000_000_003 },
    client: MOBILE_PAIRING_AUDIT_CLIENT,
    mode: "backend",
    role: "operator",
    scopes: [...MOBILE_PAIRING_APPROVAL_SCOPES],
    auth: { password: "approval-password" },
  });
  expect(approvalRequest.params).toMatchObject({
    client: { id: "gateway-client", mode: "backend" },
    role: "operator",
    scopes: ["operator.pairing", "operator.admin"],
    auth: { password: "approval-password" },
  });
  expect(approvalRequest.params).not.toHaveProperty("device");

  const states = [
    { pending: [], paired: [] },
    { pending: [{ requestId: "request-1", nodeId: "device-1" }], paired: [] },
    { pending: [], paired: [{ nodeId: "device-1" }] },
  ];
  const inspect = (state: Parameters<typeof inspectBaselineNodePairing>[0]) =>
    inspectBaselineNodePairing(state, "device-1");
  expect(inspect(states[1])).toEqual({ pendingRequestId: "request-1", paired: false });
  expect(inspect(states[2])).toEqual({ pendingRequestId: null, paired: true });
  expect(() =>
    inspect({
      pending: [{ requestId: "request-other", nodeId: "device-2" }],
      paired: [],
    }),
  ).toThrow(/unexpected pending request/);
  const observed: string[] = [];
  await approveBaselineNodePairing({
    deviceId: "device-1",
    listPairings: async () => {
      observed.push("list");
      return states.shift();
    },
    approvePairing: async (requestId) => {
      observed.push(`approve:${requestId}`);
    },
    wait: async () => {
      observed.push("wait");
    },
  });
  expect(observed).toEqual(["list", "wait", "list", "approve:request-1", "wait", "list"]);
});

it("emits only redacted reconnect evidence", () => {
  const nodeToken = "node-token-must-not-leak";
  const operatorToken = "operator-token-must-not-leak";
  const credentials = credentialsFor(nodeToken, operatorToken);
  const node = persistToken(credentials, "node", "rotated-node-token");
  const operator = persistToken(credentials, "operator", operatorToken);
  const serialized = JSON.stringify(
    buildRedactedEvidence({
      phase: "candidate-restart",
      credentials,
      node,
      operator,
      pairing: cleanPairing,
      expectKnownNodeSurfaceUpgrade: false,
    }),
  );

  expect(credentials.node).toEqual({ token: "rotated-node-token", scopes: [] });
  const { identity, client } = credentials;
  for (const secret of [nodeToken, operatorToken, identity.privateKeyPem, client.instanceId]) {
    expect(serialized).not.toContain(secret);
  }
  expect(JSON.parse(serialized)).toMatchObject({
    ...cleanPairing,
    phase: "candidate-restart",
    ok: true,
    connectedDevicePresent: true,
    pendingPairingCount: 0,
    nodeSurfaceReapprovalExpected: false,
    missingPasswordReason: true,
    missingPasswordClose1008: true,
    credentials: {
      node: tokenEvidence(nodeToken, "rotated-node-token"),
      operator: tokenEvidence(operatorToken),
    },
  });
});

it("keeps secrets out of CLI failures", () => {
  const password = "password-must-not-leak";
  const result = runProcess(
    process.execPath,
    [
      "--import",
      "./scripts/tsx.mjs",
      "scripts/e2e/lib/upgrade-survivor/mobile-pairing-client.mts",
      "unknown",
      ...Object.entries({
        "package-root": "/tmp/openclaw-package",
        credentials: "/tmp/openclaw-credentials.json",
        evidence: "/tmp/openclaw-evidence.json",
      }).flatMap(([key, value]) => [`--${key}`, value]),
    ],
    { ...process.env, GATEWAY_AUTH_PASSWORD_REF: password },
  );

  expect(result.status).toBe(1);
  expect(`${result.stdout}${result.stderr}`).not.toContain(password);
  expect(result.stderr).toContain("unknown mobile pairing client command");
});

it("checks both candidate starts before Doctor and the final phase after Doctor", () => {
  const source = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
  const position = (phase: string) => source.indexOf(`phase ${phase}`);
  const update = "update-candidate update_candidate";
  const first = "mobile-pairing-candidate-first";
  const restart = "mobile-pairing-candidate-restart";
  expect(position("bootstrap-mobile-pairing bootstrap_mobile_pairing")).toBeGreaterThan(-1);
  for (const sequence of [
    ["bootstrap-mobile-pairing bootstrap_mobile_pairing", update],
    [update, "assert-automatic-migration assert_survival", first],
    [update, "assert-historical-package-replacement-prestart", first],
    [first, "assert-historical-package-replacement-startup-repair", restart],
    [restart, "doctor run_doctor", "mobile-pairing-final"],
  ]) {
    let lastPosition = -1;
    for (const phase of sequence) {
      const nextPosition = position(phase);
      expect(nextPosition).toBeGreaterThan(lastPosition);
      lastPosition = nextPosition;
    }
  }
});
