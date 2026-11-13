import { ServerResponse } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { expect, test } from "vitest";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { HelloOkSchema } from "../../packages/gateway-protocol/src/schema/frames.js";
import type { UsersSelfResult } from "../../packages/gateway-protocol/src/schema/users.js";
import { issueControlUiBrowserHandoff } from "../commands/control-ui-handoff.js";
import { replaceConfigFile } from "../config/config.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { issueDeviceBootstrapToken } from "../infra/device-bootstrap.js";
import { getPairedDevice } from "../infra/device-pairing.js";
import { FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE } from "../shared/device-bootstrap-profile.js";
import {
  loadDeviceIdentity,
  pairDeviceIdentity,
  openTrackedWs,
} from "./device-authz.test-helpers.js";
import { authorizeControlUiReadRequestOrReply } from "./http-auth-utils.js";
import { createRequest } from "./server-http.test-harness.js";
import { CONTROL_UI_CLIENT } from "./server.auth.test-helpers.js";
import {
  installGatewayTestHooks,
  startServerWithClient,
  connectReq,
  connectOk,
  rpcReq,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
await import("./server.js");
const BACKEND_CLIENT = {
  id: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
  version: "1.0.0",
  platform: "node",
  mode: GATEWAY_CLIENT_MODES.BACKEND,
} as const;

function deliveredNativeAuth(result: Awaited<ReturnType<typeof connectReq>>) {
  const auth = result.payload?.auth;
  if (!result.ok || !Value.Check(HelloOkSchema.properties.auth, auth)) {
    throw new Error("Expected a valid native credential handoff");
  }
  return auth;
}

test("enrolled operator identity survives reconnect and bounds both WS and HTTP before revocation", async () => {
  const origin = "https://personal-enrollment.example.test";
  const auth = {
    mode: "token",
    token: "synthetic-personal-enrollment-secret",
    allowTailscale: false,
  } as const;
  const gateway = {
    roles: {
      default: "writer",
      definitions: {
        writer: {
          sessions: { others: "view" },
          agents: "*",
          scopes: ["operator.read", "operator.write"],
        },
      },
    },
  } satisfies NonNullable<OpenClawConfig["gateway"]>;
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = { allowedOrigins: [origin] };
  await replaceConfigFile({
    nextConfig: { gateway: { ...gateway, auth, controlUi: { allowedOrigins: [origin] } } },
    afterWrite: { mode: "auto" },
  });
  const started = await startServerWithClient(undefined, { auth, controlUiEnabled: true });
  const identity = await pairDeviceIdentity({
    name: "personal-operator",
    role: "operator",
    scopes: ["operator.admin"],
    clientId: CONTROL_UI_CLIENT.id,
    clientMode: CONTROL_UI_CLIENT.mode,
    platform: CONTROL_UI_CLIENT.platform,
  });
  const handoffSockets: Awaited<ReturnType<typeof openTrackedWs>>[] = [];
  let browser: Awaited<ReturnType<typeof openTrackedWs>> | undefined;
  let personal: Awaited<ReturnType<typeof openTrackedWs>> | undefined;
  try {
    await connectOk(started.ws, {
      client: BACKEND_CLIENT,
      token: auth.token,
      device: null,
      scopes: ["operator.admin"],
    });
    browser = await openTrackedWs(started.port, { origin });
    await connectOk(browser, {
      token: auth.token,
      client: CONTROL_UI_CLIENT,
      scopes: ["operator.admin"],
      deviceIdentityPath: identity.identityPath,
    });
    const enrolled = await rpcReq<{
      deviceId: string;
      profileId: string;
      operatorToken?: { token: string; scopes: string[] };
    }>(browser, "device.profile.enroll", {
      enrollmentId: "7b75c3c3-2917-4b9c-8003-b718beec88bc",
      name: "Local Person",
    });
    expect(enrolled.ok, JSON.stringify(enrolled.error)).toBe(true);
    const record = enrolled.payload;
    if (!record?.operatorToken) {
      throw new Error("Self enrollment must return its operator credential");
    }
    expect(record.deviceId).toBe(identity.identity.deviceId);
    expect(record.profileId).not.toBe("gateway-owner");
    expect((await getPairedDevice(record.deviceId))?.operatorProfileId).toBe(record.profileId);
    personal = await openTrackedWs(started.port, { origin });
    const hello = await connectReq(personal, {
      skipDefaultAuth: true,
      deviceToken: record.operatorToken.token,
      client: CONTROL_UI_CLIENT,
      scopes: ["operator.admin"],
      deviceIdentityPath: identity.identityPath,
    });
    expect(hello.ok, JSON.stringify(hello.error)).toBe(true);
    expect(hello.payload).toMatchObject({ auth: { scopes: ["operator.read", "operator.write"] } });
    const self = await rpcReq<UsersSelfResult>(personal, "users.self", {});
    expect(self.payload?.profile).toMatchObject({
      id: record.profileId,
      displayName: "Local Person",
      emails: [],
    });
    expect(
      (
        await rpcReq(personal, "device.token.rotate", {
          deviceId: record.deviceId,
          role: "operator",
        })
      ).ok,
    ).toBe(false);

    for (const alreadyPaired of [false, true]) {
      const nextIdentity = alreadyPaired
        ? await pairDeviceIdentity({
            name: "existing-unbound-personal-handoff",
            role: "operator",
            scopes: ["operator.admin"],
            clientId: CONTROL_UI_CLIENT.id,
            clientMode: CONTROL_UI_CLIENT.mode,
            platform: CONTROL_UI_CLIENT.platform,
          })
        : loadDeviceIdentity("fresh-personal-handoff");
      const handoff = await issueControlUiBrowserHandoff(
        {
          httpUrl: "http://127.0.0.1:" + started.port + "/",
          wsUrl: "ws://127.0.0.1:" + started.port,
        },
        { profileId: record.profileId },
      );
      const bootstrapToken = new URLSearchParams(new URL(handoff.browserUrl).hash.slice(1)).get(
        "bootstrapToken",
      );
      if (!bootstrapToken) {
        throw new Error("Expected the host-issued personal handoff");
      }
      const socket = await openTrackedWs(started.port, { origin });
      handoffSockets.push(socket);
      const admitted = await connectReq(socket, {
        skipDefaultAuth: true,
        bootstrapToken,
        client: CONTROL_UI_CLIENT,
        scopes: ["operator.admin"],
        deviceIdentityPath: nextIdentity.identityPath,
      });
      expect(admitted.ok, JSON.stringify(admitted.error)).toBe(true);
      expect(admitted.payload).toMatchObject({
        auth: { scopes: ["operator.read", "operator.write"] },
      });
      expect((await rpcReq<UsersSelfResult>(socket, "users.self", {})).payload?.profile?.id).toBe(
        record.profileId,
      );
    }

    for (const alreadyPaired of [false, true]) {
      const mobile = loadDeviceIdentity("personal-mobile-" + alreadyPaired);
      const client = {
        id: "openclaw-android",
        version: "1.0.0",
        platform: "Android 16",
        mode: "node",
        deviceFamily: "Android",
      } as const;
      let previousNodeToken: string | undefined;
      if (alreadyPaired) {
        const previous = await openTrackedWs(started.port);
        handoffSockets.push(previous);
        const admitted = deliveredNativeAuth(
          await connectReq(previous, {
            token: auth.token,
            role: "node",
            scopes: [],
            client,
            deviceIdentityPath: mobile.identityPath,
          }),
        );
        previousNodeToken = admitted.deviceToken;
        if (!previousNodeToken) {
          throw new Error("Expected the approved node credential");
        }
        previous.close();
      }
      const issued = await issueDeviceBootstrapToken({
        profile: {
          ...FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
          operatorProfileId: record.profileId,
        },
      });
      const node = await openTrackedWs(started.port);
      handoffSockets.push(node);
      const receipt = deliveredNativeAuth(
        await connectReq(node, {
          skipDefaultAuth: true,
          bootstrapToken: issued.token,
          role: "node",
          scopes: [],
          client,
          deviceIdentityPath: mobile.identityPath,
        }),
      );
      expect(receipt).toMatchObject({ role: "node", scopes: [] });
      const operator = receipt.deviceTokens?.find((grant) => grant.role === "operator");
      if (!receipt.deviceToken || !operator) {
        throw new Error("Expected independent node and operator handoffs");
      }
      expect(operator.scopes).toEqual(["operator.read", "operator.write"]);
      if (previousNodeToken) {
        expect(receipt.deviceToken).toBe(previousNodeToken);
      }
      expect((await rpcReq<UsersSelfResult>(node, "users.self", {})).payload?.profile?.id).not.toBe(
        record.profileId,
      );
      const human = await openTrackedWs(started.port);
      handoffSockets.push(human);
      await connectOk(human, {
        skipDefaultAuth: true,
        deviceToken: operator.deviceToken,
        role: "operator",
        scopes: operator.scopes,
        client: { ...client, mode: "ui" },
        deviceIdentityPath: mobile.identityPath,
      });
      expect((await rpcReq<UsersSelfResult>(human, "users.self", {})).payload?.profile?.id).toBe(
        record.profileId,
      );
      const reconnect = await openTrackedWs(started.port);
      handoffSockets.push(reconnect);
      await connectOk(reconnect, {
        skipDefaultAuth: true,
        deviceToken: receipt.deviceToken,
        role: "node",
        scopes: [],
        client,
        deviceIdentityPath: mobile.identityPath,
      });
      expect((await getPairedDevice(mobile.identity.deviceId))?.tokens?.node?.token).toBe(
        receipt.deviceToken,
      );
    }

    const req = createRequest({
      path: "/control-ui-config.json",
      authorization: "Bearer " + record.operatorToken.token,
    });
    const res = new ServerResponse(req);
    const cfg = expectDefined(getRuntimeConfigSnapshot(), "Gateway policy");
    try {
      const admitted = await authorizeControlUiReadRequestOrReply({
        req,
        res,
        auth,
        cfg,
        getRuntimeConfig: () => cfg,
      });
      expect(admitted?.authenticatedUserProfile?.profileId).toBe(record.profileId);
      expect(admitted?.operatorScopes).toEqual(["operator.read", "operator.write"]);
      expect(admitted?.hasCurrentClientAuthority()).toBe(true);
      expect(
        (
          await rpcReq(started.ws, "device.token.revoke", {
            deviceId: record.deviceId,
            role: "operator",
          })
        ).ok,
      ).toBe(true);
      expect(admitted?.hasCurrentClientAuthority()).toBe(false);
      await expect(admitted?.revalidate?.()).rejects.toThrow();
    } finally {
      res.destroy();
      req.destroy();
    }
  } finally {
    for (const socket of handoffSockets) {
      socket.close();
    }
    browser?.close();
    personal?.close();
    started.ws.close();
    await started.server.close();
    started.envSnapshot.restore();
  }
});
