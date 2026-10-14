import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const CLIENT_PATH = "scripts/e2e/lib/upgrade-survivor/mobile-pairing-client.mts";
const RUNNER_PATH = "scripts/e2e/lib/upgrade-survivor/run.sh";

afterEach(() => {
  vi.useRealTimers();
});

function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function bootstrapHello(nodeToken: string, operatorToken: string) {
  return {
    type: "hello-ok",
    auth: {
      role: "node",
      scopes: [],
      deviceToken: nodeToken,
      deviceTokens: [
        {
          role: "operator",
          scopes: [
            "operator.approvals",
            "operator.read",
            "operator.talk.secrets",
            "operator.write",
          ],
          deviceToken: operatorToken,
          issuedAtMs: 1,
        },
      ],
    },
  };
}

describe("upgrade survivor mobile pairing client", () => {
  it.each([
    {
      failure: "the connect response times out",
      stage: "response",
      error: "Gateway response timed out",
    },
    {
      failure: "WebSocket opening fails",
      stage: "open",
      error: "Gateway WebSocket open failed",
    },
    {
      failure: "sending the connect request fails",
      stage: "send",
      error: "fixture send failed",
    },
  ])("closes the WebSocket and releases waiters when $failure", async ({ stage, error }) => {
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

    expect(FailureSocket.instances).toHaveLength(1);
    expect(FailureSocket.instances[0]?.closeCalls).toBe(1);
    expect(FailureSocket.instances[0]?.readyState).toBe(FailureSocket.CLOSED);
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
    const nodeRequest = buildConnectRequest({
      id: "connect-1",
      challengePayload,
      client: MOBILE_PAIRING_CLIENT,
      mode: "node",
      role: "node",
      scopes: [],
      auth: { token: "node-token" },
      identity,
    });
    const operatorRequest = buildConnectRequest({
      id: "connect-2",
      challengePayload,
      client: MOBILE_PAIRING_CLIENT,
      mode: "ui",
      role: "operator",
      scopes: ["operator.read"],
      auth: { token: "operator-token" },
      identity,
    });
    const nodeParams = nodeRequest.params as {
      minProtocol: number;
      maxProtocol: number;
      client: Record<string, string>;
      caps: string[];
      commands: string[];
      permissions: Record<string, boolean>;
      locale: string;
      userAgent: string;
      auth: Record<string, string>;
      device: { nonce: string; signature: string; signedAt: number };
    };
    const operatorParams = operatorRequest.params as {
      minProtocol: number;
      maxProtocol: number;
      caps: string[];
      auth: Record<string, string>;
    };
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
    expect(nodeParams.auth).not.toHaveProperty("deviceToken");
    expect(operatorParams.auth).not.toHaveProperty("deviceToken");
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
    const identity = createMobilePairingIdentity();
    const bootstrap = parseQrBootstrapJson({ setupCode });
    const credentials = extractBootstrapCredentials({
      url: bootstrap.url,
      client: MOBILE_PAIRING_CLIENT,
      identity,
      hello: bootstrapHello(nodeToken, operatorToken),
    });

    expect(bootstrap).toEqual({
      url: "ws://127.0.0.1:18789",
      bootstrapToken: "bootstrap-token-secret",
    });
    expect(credentials.node).toEqual({ token: nodeToken, scopes: [] });
    expect(credentials.operator).toEqual({
      token: operatorToken,
      scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
    });
    expect(credentials.operator.scopes).not.toContain("operator.pairing");
    expect(credentials.operator.scopes).not.toContain("operator.admin");
    expect(credentials.client.instanceId).toBe(MOBILE_PAIRING_CLIENT.instanceId);
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
    expect(
      validatePairingAudit({
        devicePairing: { pending: [], paired: [{ deviceId: "device-1" }] },
        nodePairing: { pending: [], paired: [pairedNode] },
        deviceId: "device-1",
      }),
    ).toEqual({
      pendingDevicePairingCount: 0,
      pendingNodePairingCount: 0,
      pairedDevicePresent: true,
      pairedNodePresent: true,
      nodeSurfaceReapprovalRequired: false,
      nodeSurfaceCommandAdditions: [],
    });
    expect(
      validatePairingAudit({
        devicePairing: { pending: [], paired: [{ deviceId: "device-1" }] },
        nodePairing: { pending: [pendingNode], paired: [pairedNode] },
        deviceId: "device-1",
        expectKnownNodeSurfaceUpgrade: true,
      }),
    ).toEqual({
      pendingDevicePairingCount: 0,
      pendingNodePairingCount: 1,
      pairedDevicePresent: true,
      pairedNodePresent: true,
      nodeSurfaceReapprovalRequired: true,
      nodeSurfaceCommandAdditions: ["watch.notify", "watch.status"],
    });
    expect(() =>
      validatePairingAudit({
        devicePairing: { pending: [], paired: [{ deviceId: "device-1" }] },
        nodePairing: { pending: [pendingNode], paired: [pairedNode] },
        deviceId: "device-1",
      }),
    ).toThrow(/unexpected pending request/);
    for (const invalidPending of [
      { ...pendingNode, nodeId: "device-2" },
      { ...pendingNode, commands: ["camera.snap", "watch.status"] },
      { ...pendingNode, caps: ["camera", "microphone"] },
      { ...pendingNode, permissions: { camera: true, screenRecording: true } },
    ]) {
      expect(() =>
        validatePairingAudit({
          devicePairing: { pending: [], paired: [{ deviceId: "device-1" }] },
          nodePairing: { pending: [invalidPending], paired: [pairedNode] },
          deviceId: "device-1",
          expectKnownNodeSurfaceUpgrade: true,
        }),
      ).toThrow();
    }
    for (const narrowedPending of [
      { ...pendingNode, commands: ["watch.notify", "watch.status"] },
      { ...pendingNode, caps: [] },
      { ...pendingNode, permissions: { camera: false } },
    ]) {
      expect(() =>
        validatePairingAudit({
          devicePairing: { pending: [], paired: [{ deviceId: "device-1" }] },
          nodePairing: { pending: [narrowedPending], paired: [pairedNode] },
          deviceId: "device-1",
          expectKnownNodeSurfaceUpgrade: true,
        }),
      ).not.toThrow();
    }
    expect(() =>
      validatePairingAudit({
        devicePairing: { pending: [], paired: [{ deviceId: "device-1" }] },
        nodePairing: { pending: [pendingNode, pendingNode], paired: [pairedNode] },
        deviceId: "device-1",
        expectKnownNodeSurfaceUpgrade: true,
      }),
    ).toThrow(/unexpected pending request/);
    expect(() =>
      validatePairingAudit({
        devicePairing: { pending: [], paired: [{ deviceId: "device-1" }] },
        nodePairing: { pending: [], paired: [pairedNode] },
        deviceId: "device-1",
        expectKnownNodeSurfaceUpgrade: true,
      }),
    ).toThrow(/omitted the expected command-surface reapproval/);
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

    expect(
      inspectBaselineNodePairing(
        {
          pending: [{ requestId: "request-1", nodeId: "device-1" }],
          paired: [],
        },
        "device-1",
      ),
    ).toEqual({ pendingRequestId: "request-1", paired: false });
    expect(
      inspectBaselineNodePairing(
        {
          pending: [],
          paired: [{ nodeId: "device-1" }],
        },
        "device-1",
      ),
    ).toEqual({ pendingRequestId: null, paired: true });
    expect(() =>
      inspectBaselineNodePairing(
        {
          pending: [{ requestId: "request-other", nodeId: "device-2" }],
          paired: [],
        },
        "device-1",
      ),
    ).toThrow(/unexpected pending request/);

    const observed: string[] = [];
    const states = [
      { pending: [], paired: [] },
      { pending: [{ requestId: "request-1", nodeId: "device-1" }], paired: [] },
      { pending: [], paired: [{ nodeId: "device-1" }] },
    ];
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
    const credentials = extractBootstrapCredentials({
      url: "ws://127.0.0.1:18789",
      client: MOBILE_PAIRING_CLIENT,
      identity: createMobilePairingIdentity(),
      hello: bootstrapHello(nodeToken, operatorToken),
    });
    const node = persistHelloCredential({
      credentials,
      role: "node",
      hello: {
        type: "hello-ok",
        auth: { role: "node", scopes: [], deviceToken: "rotated-node-token" },
      },
    });
    const operator = persistHelloCredential({
      credentials,
      role: "operator",
      hello: {
        type: "hello-ok",
        auth: {
          role: "operator",
          scopes: credentials.operator.scopes,
          deviceToken: operatorToken,
        },
      },
    });
    const serialized = JSON.stringify(
      buildRedactedEvidence({
        phase: "candidate-restart",
        credentials,
        node,
        operator,
        pairing: {
          pendingDevicePairingCount: 0,
          pendingNodePairingCount: 0,
          pairedDevicePresent: true,
          pairedNodePresent: true,
          nodeSurfaceReapprovalRequired: false,
          nodeSurfaceCommandAdditions: [],
        },
        expectKnownNodeSurfaceUpgrade: false,
      }),
    );

    expect(credentials.node).toEqual({ token: "rotated-node-token", scopes: [] });
    expect(serialized).not.toContain(nodeToken);
    expect(serialized).not.toContain(operatorToken);
    expect(serialized).not.toContain(credentials.identity.privateKeyPem);
    expect(serialized).not.toContain(credentials.client.instanceId);
    expect(JSON.parse(serialized)).toMatchObject({
      phase: "candidate-restart",
      ok: true,
      connectedDevicePresent: true,
      pendingPairingCount: 0,
      pendingDevicePairingCount: 0,
      pendingNodePairingCount: 0,
      pairedDevicePresent: true,
      pairedNodePresent: true,
      nodeSurfaceReapprovalRequired: false,
      nodeSurfaceCommandAdditions: [],
      nodeSurfaceReapprovalExpected: false,
      missingPasswordReason: true,
      missingPasswordClose1008: true,
      credentials: {
        node: {
          usedTokenHash: tokenHash(nodeToken),
          storedTokenHash: tokenHash("rotated-node-token"),
          deviceTokenReturned: true,
          tokenRotated: true,
        },
        operator: {
          usedTokenHash: tokenHash(operatorToken),
          storedTokenHash: tokenHash(operatorToken),
          deviceTokenReturned: true,
          tokenRotated: false,
        },
      },
    });
  });

  it("keeps secrets out of CLI failures", () => {
    const password = "password-must-not-leak";
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "./scripts/tsx.mjs",
        CLIENT_PATH,
        "unknown",
        "--package-root",
        "/tmp/openclaw-package",
        "--credentials",
        "/tmp/openclaw-credentials.json",
        "--evidence",
        "/tmp/openclaw-evidence.json",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, GATEWAY_AUTH_PASSWORD_REF: password },
      },
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain(password);
    expect(result.stderr).toContain("unknown mobile pairing client command");
  });

  it("checks both candidate starts before Doctor and the final phase after Doctor", () => {
    const source = readFileSync(RUNNER_PATH, "utf8");
    const bootstrap = source.indexOf("phase bootstrap-mobile-pairing bootstrap_mobile_pairing");
    const update = source.indexOf("phase update-candidate update_candidate");
    const automaticMigration = source.indexOf("phase assert-automatic-migration assert_survival");
    const historicalPrestart = source.indexOf(
      "phase assert-historical-package-replacement-prestart",
    );
    const candidateFirst = source.indexOf("phase mobile-pairing-candidate-first");
    const historicalStartupRepair = source.indexOf(
      "phase assert-historical-package-replacement-startup-repair",
    );
    const candidateRestart = source.indexOf("phase mobile-pairing-candidate-restart");
    const doctor = source.indexOf("phase doctor run_doctor");
    const final = source.indexOf("phase mobile-pairing-final");

    expect(bootstrap).toBeGreaterThan(-1);
    expect(bootstrap).toBeLessThan(update);
    expect(update).toBeLessThan(automaticMigration);
    expect(automaticMigration).toBeLessThan(candidateFirst);
    expect(update).toBeLessThan(historicalPrestart);
    expect(historicalPrestart).toBeLessThan(candidateFirst);
    expect(update).toBeLessThan(candidateFirst);
    expect(candidateFirst).toBeLessThan(historicalStartupRepair);
    expect(historicalStartupRepair).toBeLessThan(candidateRestart);
    expect(candidateFirst).toBeLessThan(candidateRestart);
    expect(candidateRestart).toBeLessThan(doctor);
    expect(doctor).toBeLessThan(final);
  });
});
