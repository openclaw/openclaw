import { describe, expect, test } from "vitest";
import type { HelloOk } from "../../../../packages/gateway-protocol/src/schema/frames.js";
import type { UsersListResult } from "../../../../packages/gateway-protocol/src/schema/users.js";
import { issueDeviceBootstrapToken } from "../../../infra/device-bootstrap.js";
import {
  CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES,
  CONTROL_UI_OWNER_BOOTSTRAP_PROFILE,
} from "../../../shared/device-bootstrap-profile.js";
import { setUserProfileRole } from "../../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { loadDeviceIdentity, openTrackedWs } from "../../device-authz.test-helpers.js";
import {
  BROWSER_ORIGIN,
  configureBrowserAuth,
  CONTROL_UI_CLIENT,
} from "../../server.auth.test-helpers.js";
import {
  connectReq,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "../../test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
await import("../../server.js");

describe("definitions-only operator admission", () => {
  test("allows setup-code and device-token operators with definitions alone and no effective role", async () => {
    const origin = BROWSER_ORIGIN;
    const auth = { mode: "token", token: "definitions-only-secret" } as const;
    await configureBrowserAuth(auth, {
      roles: {
        definitions: {
          guest: { sessions: { others: "none" }, agents: [], scopes: [] },
        },
      },
    });
    const started = await startServerWithClient(undefined, {
      auth,
      controlUiEnabled: true,
      wsHeaders: { origin },
    });
    try {
      const issued = await issueDeviceBootstrapToken({
        profile: CONTROL_UI_OWNER_BOOTSTRAP_PROFILE,
      });
      const loaded = loadDeviceIdentity("definitions-only-bootstrap");
      const options = {
        role: "operator",
        scopes: [...CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES],
        client: CONTROL_UI_CLIENT,
        deviceIdentityPath: loaded.identityPath,
      };
      const bootstrap = await connectReq(started.ws, {
        ...options,
        skipDefaultAuth: true,
        bootstrapToken: issued.token,
      });
      expect(bootstrap.ok, JSON.stringify(bootstrap)).toBe(true);
      const deviceToken = (bootstrap.payload as HelloOk).auth.deviceToken;
      expect(deviceToken).toBeTruthy();
      const reconnect = await openTrackedWs(started.port, { origin });
      const connected = await connectReq(reconnect, {
        ...options,
        skipDefaultAuth: true,
        deviceToken,
      });
      expect(connected.ok, JSON.stringify(connected)).toBe(true);
      expect((connected.payload as HelloOk).auth.sessionCap).toBeUndefined();
      const person = ensureProfileForEmail("definitions-only@example.test");
      setUserProfileRole(person.id, "guest");
      const listed = await rpcReq<UsersListResult>(reconnect, "users.list", {});
      expect(listed.ok).toBe(true);
      expect(listed.payload?.profiles.find((p) => p.id === person.id)).toMatchObject({
        role: "guest",
      });
      expect(
        listed.payload?.profiles.find((p) => p.id === person.id)?.effectiveRole,
      ).toBeUndefined();
      const assigned = await rpcReq(reconnect, "users.setRole", {
        profileId: person.id,
        role: "guest",
      });
      expect(assigned.error?.message).toContain("gateway.roles.default");
      expect(
        (await rpcReq(reconnect, "users.setRole", { profileId: person.id, role: null })).ok,
      ).toBe(true);
      reconnect.close();
    } finally {
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});
