import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import * as operations from "../mcp-app-operations.js";
import { gatewayRequest } from "../request-frame.test-support.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { mcpAppHandlers } from "./mcp-app.js";

afterEach(() => vi.restoreAllMocks());

it.each(["mcp.app.view", "mcp.app.readResource"] as const)(
  "%s survives session metadata updates but rejects changed access",
  (method) =>
    withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const reader = roleClient("view", "mcp-app-reader");
      prepareGatewayRecipientProfile(reader);
      const owner = roleClient("view", "mcp-app-owner");
      const cfg = rolePolicyConfig();
      setRuntimeConfigSnapshot(cfg);
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      const sessionKey = "agent:main:mcp-app-metadata";
      const scope = { agentId: "main", sessionKey };
      const entry: SessionEntry = {
        sessionId: "mcp-app-metadata",
        lifecycleRevision: "original",
        updatedAt: 1,
        visibility: "shared",
        createdActor: {
          type: "human",
          source: "profile",
          id: owner.authenticatedUserProfile!.profileId,
        },
      };
      let update: Partial<SessionEntry> = {};
      // A real committed write lands while the retained read spans the App's async work.
      const writeDuringRead = () => replaceSessionEntrySync(scope, { ...entry, ...update });
      const active = { view: { agentId: "main" }, runtime: {} } as Awaited<
        ReturnType<typeof operations.resolveMcpAppActiveView>
      >;
      vi.spyOn(operations, "resolveMcpAppActiveView").mockImplementation(async () => {
        if (method === "mcp.app.view") {
          writeDuringRead();
        }
        return active;
      });
      vi.spyOn(operations, "withMcpAppActiveView").mockResolvedValue({ rendered: true });
      vi.spyOn(operations, "executeMcpAppOperation").mockImplementation(
        async (_active, _operation, run) => {
          writeDuringRead();
          run.assertCurrent();
          return { contents: [] };
        },
      );
      const cases: [name: string, change: Partial<SessionEntry>, allowed: boolean][] = [
        ["unchanged", {}, true],
        ["activity and label", { updatedAt: 2, label: "Still working", totalTokens: 123 }, true],
        ["visibility revoked", { visibility: "draft" }, false],
        ["session replaced", { sessionId: "replacement" }, false],
      ];
      for (const [name, change, allowed] of cases) {
        replaceSessionEntrySync(scope, entry);
        update = change;
        const respond = vi.fn();
        await handleGatewayRequest({
          req: gatewayRequest(name, method, { sessionKey, viewId: "cv_app", uri: "ui://demo/app" }),
          client: reader,
          context,
          respond,
          isWebchatConnect: () => false,
          extraHandlers: mcpAppHandlers,
        });
        expect(respond.mock.calls[0]?.[0], `${name}: ${JSON.stringify(respond.mock.calls)}`).toBe(
          allowed,
        );
      }
    }),
);
