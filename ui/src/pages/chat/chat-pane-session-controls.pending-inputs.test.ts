import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createApplicationGatewaySnapshot } from "../../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  createChatPanePendingInputControls,
  readChatPaneMutationAccess,
} from "./chat-pane-session-controls.ts";

const sessionKey = "agent:main:retired-inputs";

function paneAccess(
  scopes: string[],
  sharingRole: GatewaySessionRow["sharingRole"],
  methods = ["chat.pendingInputs.dismiss", "chat.steerNow"],
) {
  const session = {
    key: sessionKey,
    sharingRole,
    kind: "direct",
    updatedAt: 0,
  } satisfies GatewaySessionRow;
  return {
    session,
    access: readChatPaneMutationAccess(
      createApplicationGatewaySnapshot({
        phase: "connected",
        client: createTestGatewayClient(async () => ({})),
        hello: gatewayHelloForMethods(methods, scopes),
      }),
      sessionKey,
      session,
    ),
  };
}

function dismissAccess(
  scopes: string[],
  sharingRole: GatewaySessionRow["sharingRole"],
  methods = ["chat.pendingInputs.dismiss"],
) {
  return paneAccess(scopes, sharingRole, methods).access.pendingInputDismiss;
}

describe("pending input dismissal access", () => {
  it("follows the Gateway's own-session write gate", () => {
    expect(dismissAccess(["operator.write"], "member").allowed).toBe(true);
    expect(dismissAccess(["operator.sessions.write"], "owner").allowed).toBe(true);
    expect(dismissAccess(["operator.sessions.write"], "member")).toMatchObject({
      allowed: false,
      cause: "session-not-owned",
    });
    expect(dismissAccess(["operator.read"], "owner")).toMatchObject({
      allowed: false,
      cause: "missing-scope",
    });
    expect(dismissAccess(["operator.write"], "owner", [])).toMatchObject({
      allowed: false,
      cause: "method-unavailable",
    });
  });

  it("keeps pending input actions for session writers, including with a broad write grant", () => {
    const options = { nativeConversation: true, participationBlocked: false };
    const member = paneAccess(["operator.write"], "member");
    expect(createChatPanePendingInputControls(member.access, member.session, options)).toEqual({
      canDismissPendingInputs: true,
      canSteerNow: true,
    });
    const owner = paneAccess(["operator.sessions.write"], "owner");
    expect(createChatPanePendingInputControls(owner.access, owner.session, options)).toEqual({
      canDismissPendingInputs: true,
      canSteerNow: true,
    });
    const viewer = paneAccess(["operator.write"], "viewer");
    expect(viewer.access.pendingInputDismiss.allowed).toBe(true);
    expect(createChatPanePendingInputControls(viewer.access, viewer.session, options)).toEqual({
      canDismissPendingInputs: false,
      canSteerNow: false,
    });
    const reader = paneAccess(["operator.read"], "owner");
    expect(
      createChatPanePendingInputControls(reader.access, reader.session, options).canSteerNow,
    ).toBe(false);
  });
});
