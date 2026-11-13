import { expect, test, vi } from "vitest";
import type { ToolsEffectiveResult } from "../../../packages/gateway-protocol/src/schema/tools-catalog.js";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { CODEX_GITHUB_PREVIEW_UNAVAILABLE_NOTICE } from "../../agents/tools-effective-inventory-shared.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { applySessionEntryCanonicalReplacements } from "../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { createDeferredCore } from "../../shared/deferred.js";
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

test("retains confidential materialized rows and rechecks audience before tool publication", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg = {};
    setRuntimeConfigSnapshot(cfg);
    const creator = roleClient("view", "tools-confidential-creator");
    const selected = roleClient("view", "tools-confidential-selected");
    const outsider = roleClient("view", "tools-confidential-outsider");
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    const sessionKey = "agent:main:confidential-tool-preview";
    const scope = { agentId: "main", sessionKey };
    await upsertSessionEntryCore(scope, {
      sessionId: "confidential-tools",
      updatedAt: 1,
      visibility: "shared",
      createdActor: {
        type: "human",
        source: "profile",
        id: creator.authenticatedUserProfile!.profileId,
      },
      access: { mode: "audience", profileIds: [selected.authenticatedUserProfile!.profileId] },
    });
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const request = (client: typeof selected, key = sessionKey) => {
      const respond = vi.fn();
      const pending = handleGatewayRequest({
        req: gatewayRequest("confidential-tools", "tools.effective", { sessionKey: key }),
        client,
        context,
        respond,
        isWebchatConnect: () => false,
        extraHandlers: toolsEffectiveHandlers,
      });
      return { respond, pending };
    };
    inventoryMocks.resolveEffectiveToolInventory.mockResolvedValue(inventory);
    for (const client of [creator, selected]) {
      testing.resetToolsEffectiveCacheForTest();
      const allowed = request(client);
      await allowed.pending;
      expect(allowed.respond).toHaveBeenCalledExactlyOnceWith(true, inventory, undefined);
    }
    for (const key of [sessionKey, "agent:main:missing-tool-preview"]) {
      inventoryMocks.resolveEffectiveToolInventory.mockClear();
      const denied = request(outsider, key);
      await denied.pending;
      expect(denied.respond).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("was not found"),
        }),
      );
      expect(inventoryMocks.resolveEffectiveToolInventory).not.toHaveBeenCalled();
    }
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    testing.resetToolsEffectiveCacheForTest();
    inventoryMocks.resolveEffectiveToolInventory.mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
      return inventory;
    });
    const pending = request(selected);
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        pending.pending,
        "tool inventory did not enter",
      );
      await applySessionEntryCanonicalReplacements({
        agentId: "main",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
        sessionKeys: [sessionKey],
        update: (rows) => ({
          result: undefined,
          replacements: rows.map((row) => ({
            ...row,
            previousSessionKeys: [],
            accessMutation: true,
            entry: { ...row.entry, access: { mode: "creator" as const } },
          })),
        }),
      });
    } finally {
      resume.resolve();
      await pending.pending;
    }
    expect(pending.respond).toHaveBeenCalledExactlyOnceWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("was not found"),
      }),
    );
  });
});
