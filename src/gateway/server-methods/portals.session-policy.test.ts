import { describe, expect, it, vi } from "vitest";
import { createCoreGatewayMethodDescriptors } from "../methods/core-method-policy.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { handleGatewayRequest } from "../server-methods.js";
import {
  createContext,
  createOperatorClient,
} from "../server-plugin-in-process-dispatch.test-support.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";
import { portalHandlers } from "./portals.js";

vi.mock("../../state/user-channel-identity-operations.js", () => ({
  prepareUserProfileRoleAuthority: async () => ({
    profileId: "writer",
    role: null,
    aliases: ["writer"],
    isCurrent: () => true,
  }),
}));

describe("session Portal RPC policy admission", () => {
  it.each(["operator.write", "operator.sessions.write"])(
    "rejects a locked canonical session through the actual router under %s",
    async (scope) => {
      const sessionKey = "agent:main:preview";
      const projection = createSessionRowProjectionFixture({
        cfg: {},
        store: {
          [sessionKey]: {
            sessionId: "conversation",
            lifecycleRevision: "incarnation",
            updatedAt: 1,
            modelSelectionLocked: true,
            visibility: "shared",
            createdActor: { type: "human", source: "profile", id: "writer" },
          },
        },
      });
      const context = bindSessionRowProjection(createContext(), () => projection);
      const method = "portal.session.open";
      const handler = vi.fn(portalHandlers[method]!);
      const methodRegistry = createGatewayMethodRegistry(
        createCoreGatewayMethodDescriptors({ [method]: handler }),
      );
      const respond = vi.fn();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "locked-preview",
          method,
          params: { sessionKey, environmentId: "attached", port: 3000 },
        },
        client: createOperatorClient({ profileId: "writer", scopes: [scope] }),
        context,
        methodRegistry,
        respond,
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "FORBIDDEN",
          message: expect.stringContaining("locked model selection"),
          details: { code: "SESSION_RESOURCE_TOOL_POLICY" },
        }),
      );
      expect(handler).not.toHaveBeenCalled();
    },
  );
});
