import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendApnsAlert, sendApnsBackgroundWake } from "./push-apns.js";

const testAuthPrivateKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();

function createDirectApnsSendFixture(params: {
  nodeId: string;
  environment: "sandbox" | "production";
  sendResult: { status: number; apnsId: string; body: string };
}) {
  return {
    send: vi.fn().mockResolvedValue(params.sendResult),
    registration: {
      nodeId: params.nodeId,
      transport: "direct" as const,
      token: "ABCD1234ABCD1234ABCD1234ABCD1234",
      topic: "ai.openclaw.ios",
      environment: params.environment,
      updatedAtMs: 1,
    },
    auth: {
      teamId: "TEAM123",
      keyId: "KEY123",
      privateKey: testAuthPrivateKey,
    },
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
});

describe("push APNs send semantics", () => {
  it("sends alert pushes with alert headers and payload", async () => {
    const { send, registration, auth } = createDirectApnsSendFixture({
      nodeId: "ios-node-alert",
      environment: "sandbox",
      sendResult: {
        status: 200,
        apnsId: "apns-alert-id",
        body: "",
      },
    });

    const result = await sendApnsAlert({
      registration,
      nodeId: "ios-node-alert",
      title: "Wake",
      body: "Ping",
      auth,
      requestSender: send,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]?.[0];
    expect(sent?.pushType).toBe("alert");
    expect(sent?.priority).toBe("10");
    expect(sent?.payload).toMatchObject({
      aps: {
        alert: { title: "Wake", body: "Ping" },
        sound: "default",
      },
      openclaw: {
        kind: "push.test",
        nodeId: "ios-node-alert",
      },
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.transport).toBe("direct");
  });

  it("sends background wake pushes with silent payload semantics", async () => {
    const { send, registration, auth } = createDirectApnsSendFixture({
      nodeId: "ios-node-wake",
      environment: "production",
      sendResult: {
        status: 200,
        apnsId: "apns-wake-id",
        body: "",
      },
    });

    const result = await sendApnsBackgroundWake({
      registration,
      nodeId: "ios-node-wake",
      wakeReason: "node.invoke",
      auth,
      requestSender: send,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]?.[0];
    expect(sent?.pushType).toBe("background");
    expect(sent?.priority).toBe("5");
    expect(sent?.payload).toMatchObject({
      aps: {
        "content-available": 1,
      },
      openclaw: {
        kind: "node.wake",
        reason: "node.invoke",
        nodeId: "ios-node-wake",
      },
    });
    const sentPayload = sent?.payload as { aps?: { alert?: unknown; sound?: unknown } } | undefined;
    const aps = sentPayload?.aps;
    expect(aps?.alert).toBeUndefined();
    expect(aps?.sound).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.environment).toBe("production");
    expect(result.transport).toBe("direct");
  });

  it("defaults background wake reason when not provided", async () => {
    const { send, registration, auth } = createDirectApnsSendFixture({
      nodeId: "ios-node-wake-default-reason",
      environment: "sandbox",
      sendResult: {
        status: 200,
        apnsId: "apns-wake-default-reason-id",
        body: "",
      },
    });

    await sendApnsBackgroundWake({
      registration,
      nodeId: "ios-node-wake-default-reason",
      auth,
      requestSender: send,
    });

    const sent = send.mock.calls[0]?.[0];
    expect(sent?.payload).toMatchObject({
      openclaw: {
        kind: "node.wake",
        reason: "node.invoke",
        nodeId: "ios-node-wake-default-reason",
      },
    });
  });
});
