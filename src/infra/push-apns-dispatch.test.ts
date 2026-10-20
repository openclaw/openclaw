import { generateKeyPairSync } from "node:crypto";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sendApnsAlert,
  sendApnsBackgroundWake,
  sendApnsExecApprovalAlert,
  sendApnsExecApprovalResolvedWake,
  sendApnsPluginApprovalAlert,
  sendApnsPluginApprovalResolvedWake,
} from "./push-apns.js";
import { mockApnsRelayFetch } from "./push-apns.relay.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const apnsPrivateKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
  format: "pem",
  type: "pkcs8",
});

const senderOptionKeys = {
  direct: [
    "token",
    "topic",
    "environment",
    "bearerToken",
    "payload",
    "timeoutMs",
    "pushType",
    "priority",
  ],
};

function createApnsTransportFixture(transport: "direct" | "relay") {
  const registration = {
    nodeId: "ios-dispatch",
    topic: "ai.openclaw.ios",
    environment: "sandbox" as const,
    updatedAtMs: 1,
  };
  if (transport === "direct") {
    const send = vi.fn().mockResolvedValue({ status: 200, apnsId: "dispatch-result", body: "" });
    return {
      send,
      params: {
        registration: {
          ...registration,
          transport: "direct" as const,
          token: "abcd1234abcd1234abcd1234abcd1234",
        },
        auth: { teamId: "TEAM123", keyId: "KEY123", privateKey: apnsPrivateKey },
        requestSender: send,
      },
    };
  }
  const send = mockApnsRelayFetch({ ok: true, status: 202, environment: "sandbox" });
  return {
    send,
    params: {
      registration: {
        ...registration,
        transport: "relay" as const,
        relayHandle: "relay-dispatch",
        sendGrant: "grant-dispatch",
        installationId: "installation-dispatch",
        distribution: "official" as const,
      },
      relayConfig: { baseUrl: "https://relay.example.test", timeoutMs: 2_500 },
    },
  };
}

const requireRecord = createRequireRecord("object", "label-not-object");

function requireSendRequest(send: ReturnType<typeof vi.fn>) {
  expect(send).toHaveBeenCalledTimes(1);
  return requireRecord(send.mock.calls[0]?.[0], "APNs send request");
}

describe("APNs dispatch", () => {
  it.each([
    ["direct", "alert"],
    ["direct", "background"],
    ["relay", "alert"],
    ["relay", "background"],
  ] as const)(
    "preserves %s %s lifecycle forwarding and option omission",
    async (transport, kind) => {
      const { send, params } = createApnsTransportFixture(transport);
      const controller = new AbortController();
      const isCurrent = vi.fn().mockResolvedValue(true);
      const sendPush = (controls: { signal?: AbortSignal; isCurrent?: () => Promise<boolean> }) => {
        const common = { ...params, nodeId: "ios-dispatch", timeoutMs: 2_700, ...controls };
        return kind === "alert"
          ? sendApnsAlert({ ...common, title: "Wake", body: "Ping" })
          : sendApnsBackgroundWake({ ...common, wakeReason: "node.invoke" });
      };

      await sendPush({ signal: controller.signal, isCurrent });
      if (transport === "direct") {
        const controlled = requireSendRequest(send);
        expect(Object.keys(controlled)).toEqual([
          ...senderOptionKeys.direct,
          "signal",
          "isCurrent",
        ]);
        expect(controlled.signal).toBe(controller.signal);
        expect(controlled.isCurrent).toBe(isCurrent);
        expect(controlled.pushType).toBe(kind);
        expect(controlled.priority).toBe(kind === "alert" ? "10" : "5");
      } else {
        expect(send).toHaveBeenCalledTimes(1);
        const [url, request] = send.mock.calls[0] ?? [];
        expect(url).toBe("https://relay.example.test/v1/push/send");
        expect(request?.signal?.aborted).toBe(false);
        controller.abort();
        expect(request?.signal?.aborted).toBe(true);
        expect(new Headers(request?.headers).get("authorization")).toBe("Bearer grant-dispatch");
        expect(JSON.parse(String(request?.body))).toMatchObject({
          relayHandle: "relay-dispatch",
          pushType: kind,
          priority: kind === "alert" ? 10 : 5,
        });
      }
      expect(isCurrent).toHaveBeenCalledTimes(transport === "direct" ? 1 : 2);

      send.mockClear();
      await sendPush({});
      if (transport === "direct") {
        expect(Object.keys(requireSendRequest(send))).toEqual(senderOptionKeys.direct);
      } else {
        expect(send).toHaveBeenCalledTimes(1);
      }
      expect(isCurrent).toHaveBeenCalledTimes(transport === "direct" ? 1 : 2);
    },
  );

  it.each(["direct", "relay"] as const)(
    "ignores extraneous lifecycle controls for %s approval notifications",
    async (transport) => {
      const { send, params } = createApnsTransportFixture(transport);
      const readControl = vi.fn(() => {
        throw new Error("approval notifications must not read lifecycle controls");
      });
      const approval = Object.defineProperties(
        {
          ...params,
          nodeId: "ios-dispatch",
          approvalId: "approval-dispatch",
          gatewayDeviceId: "gateway-dispatch",
          title: "Approval",
          description: "Review this request.",
          timeoutMs: 2_700,
        },
        {
          signal: { enumerable: true, get: readControl },
          isCurrent: { enumerable: true, get: readControl },
        },
      );

      for (const sendApproval of [
        sendApnsExecApprovalAlert,
        sendApnsPluginApprovalAlert,
        sendApnsExecApprovalResolvedWake,
        sendApnsPluginApprovalResolvedWake,
      ]) {
        send.mockClear();
        await sendApproval(approval);
        if (transport === "direct") {
          expect(Object.keys(requireSendRequest(send))).toEqual(senderOptionKeys.direct);
        } else {
          expect(send).toHaveBeenCalledTimes(1);
          expect(send.mock.calls[0]?.[0]).toBe("https://relay.example.test/v1/push/send");
        }
      }
      expect(readControl).not.toHaveBeenCalled();
    },
  );
});
