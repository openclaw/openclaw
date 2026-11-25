import { expect, test, vi } from "vitest";
import type { ToolsEffectiveResult } from "../../../packages/gateway-protocol/src/schema/tools-catalog.js";
import { CODEX_GITHUB_PREVIEW_UNAVAILABLE_NOTICE } from "../../agents/tools-effective-inventory-shared.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { gatewayRequest } from "../request-frame.test-support.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { toolsEffectiveInventoryMocks as inventoryMocks } from "./tools-effective.test-support.js";
const { toolsEffectiveHandlers, testing } = await import("./tools-effective.js");

// Fixed inventory I/O; router admission, sharing and response projection are real.
const privateDetail = "/private/runtime/mcp-launch --private-option";
const githubSummary = "GitHub actions in this preview: inspect_pr.";
const inventory: ToolsEffectiveResult = {
  agentId: "main",
  profile: "coding",
  groups: [
    {
      id: "core",
      label: "Built-in tools",
      source: "core",
      tools: [
        {
          id: "exec",
          label: privateDetail,
          source: "core",
          description: privateDetail,
          rawDescription: privateDetail,
        },
        {
          id: "github_publish",
          label: "github_publish",
          source: "core",
          description: "Work with GitHub pull requests through the Gateway.",
          rawDescription: githubSummary,
        },
      ],
    },
    {
      id: "mcp",
      label: "MCP tools",
      source: "mcp",
      tools: [
        {
          id: "github_publish",
          label: privateDetail,
          source: "mcp",
          description: privateDetail,
          rawDescription: privateDetail,
          mcpServer: "example",
          mcpToolName: "read",
          deniedBySession: true,
        },
      ],
    },
  ],
  notices: [
    {
      ...CODEX_GITHUB_PREVIEW_UNAVAILABLE_NOTICE,
      message: privateDetail,
      servers: [privateDetail],
    },
    {
      id: "mcp-server-diagnostic",
      severity: "warning",
      message: privateDetail,
      servers: [privateDetail],
    },
  ],
  toolAccess: {
    checked: "local-config",
    profiles: [],
    tools: [
      {
        id: "exec",
        status: "available",
        reasons: [{ kind: "runtime", label: privateDetail, source: privateDetail }],
      },
    ],
  },
};

test("scoped tool previews preserve useful identities while withholding diagnostics", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg = rolePolicyConfig();
    setRuntimeConfigSnapshot(cfg);
    const reader = roleClient("view", "preview-reader");
    const owner = roleClient("view", "preview-owner");
    reader.connect.scopes = ["operator.sessions.read"];
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    const scope = { agentId: "main", sessionKey: "agent:main:scoped-tools" };
    const seed = (visibility: "shared" | "draft") =>
      upsertSessionEntryCore(scope, {
        sessionId: "scoped-tools",
        updatedAt: 1,
        visibility,
        createdActor: {
          type: "human",
          source: "profile",
          id: owner.authenticatedUserProfile!.profileId,
        },
      });
    await seed("shared");
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const request = () => {
      const respond = vi.fn();
      const pending = handleGatewayRequest({
        req: gatewayRequest("scoped-tools", "tools.effective", { sessionKey: scope.sessionKey }),
        client: reader,
        context,
        respond,
        isWebchatConnect: () => false,
        extraHandlers: toolsEffectiveHandlers,
      });
      return { respond, pending };
    };
    testing.resetToolsEffectiveCacheForTest();
    inventoryMocks.resolveEffectiveToolInventory.mockResolvedValue(inventory);
    const preview = request();
    await preview.pending;
    expect(preview.respond).toHaveBeenCalledOnce();
    expect(preview.respond.mock.calls[0]?.[0]).toBe(true);
    const payload = preview.respond.mock.calls[0]?.[1] as ToolsEffectiveResult;
    expect(payload.groups).toMatchObject([
      {
        tools: [
          { id: "exec", label: "exec", description: expect.any(String) },
          { id: "github_publish", description: githubSummary, rawDescription: githubSummary },
        ],
      },
      {
        tools: [
          {
            id: "github_publish",
            source: "mcp",
            description: "",
            rawDescription: "",
            mcpServer: "example",
            mcpToolName: "read",
            deniedBySession: true,
          },
        ],
      },
    ]);
    expect(payload.groups[0]!.tools[0]!.description.length).toBeGreaterThan(0);
    expect(payload).not.toHaveProperty("toolAccess");
    expect(payload.notices).toEqual([CODEX_GITHUB_PREVIEW_UNAVAILABLE_NOTICE]);
    expect(JSON.stringify(payload)).not.toContain(privateDetail);
    // Projection must not mutate the cached inventory used by broader readers.
    reader.connect.scopes = ["operator.read"];
    const broad = request();
    await broad.pending;
    expect(broad.respond).toHaveBeenCalledWith(true, inventory, undefined);
    reader.connect.scopes = ["operator.sessions.read"];

    testing.resetToolsEffectiveCacheForTest();
    inventoryMocks.resolveEffectiveToolInventory.mockRejectedValueOnce(new Error(privateDetail));
    const failed = request();
    await failed.pending;
    expect(failed.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: "Tool preview is unavailable. Retry the request.",
      }),
    );
    expect(JSON.stringify(failed.respond.mock.calls)).not.toContain(privateDetail);
  });
});
