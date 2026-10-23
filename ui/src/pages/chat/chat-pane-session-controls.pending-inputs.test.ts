import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  canDismissChatPendingInputs,
  readChatPaneMutationAccess,
} from "./chat-pane-session-controls.ts";

const sessionKey = "agent:main:retired-inputs";

function paneAccess(
  scopes: string[],
  sharingRole: GatewaySessionRow["sharingRole"],
  methods = ["chat.pendingInputs.dismiss"],
) {
  const session = { key: sessionKey, sharingRole } as GatewaySessionRow;
  return {
    session,
    access: readChatPaneMutationAccess(
      {
        phase: "connected",
        client: {} as never,
        hello: gatewayHelloForMethods(methods, scopes),
      } as never,
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
  return readChatPaneMutationAccess(
    {
      phase: "connected",
      client: {} as never,
      hello: gatewayHelloForMethods(methods, scopes),
    } as never,
    sessionKey,
    { key: sessionKey, sharingRole } as GatewaySessionRow,
  ).pendingInputDismiss;
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

  it("hides dismissal from a shared-session viewer even with a broad write grant", () => {
    const options = { nativeConversation: true, participationBlocked: false };
    const member = paneAccess(["operator.write"], "member");
    expect(canDismissChatPendingInputs(member.access, member.session, options)).toBe(true);
    const viewer = paneAccess(["operator.write"], "viewer");
    expect(viewer.access.pendingInputDismiss.allowed).toBe(true);
    expect(canDismissChatPendingInputs(viewer.access, viewer.session, options)).toBe(false);
  });
});
