import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, expect, it, vi } from "vitest";
import { createToolsEffectiveHandlers, testing } from "./tools-effective.js";
import {
  toolsEffectiveInventoryMocks as inventoryMocks,
  toolsEffectiveTestDependencies,
} from "./tools-effective.test-support.js";

beforeEach(() => {
  testing.resetToolsEffectiveCacheForTest();
  vi.clearAllMocks();
});

it("invalidates fresh inventory when only the persisted session ceiling changes", async () => {
  const sessionKey = "agent:main:subagent:policy-refresh";
  const loaded: ReturnType<typeof toolsEffectiveTestDependencies.loadGatewaySessionEntryReadOnly> =
    {
      cfg: { agents: { entries: { main: {} } } },
      agentId: "main",
      storePath: "/tmp/tools-effective-policy-refresh/sessions.sqlite",
      store: {},
      canonicalKey: sessionKey,
      storeKeys: [sessionKey],
      legacyKey: undefined,
      entry: {
        sessionId: "unchanged-session",
        updatedAt: 1,
        spawnDepth: 1,
        spawnedBy: "agent:main:main",
        inheritedToolPolicyVersion: 1,
      },
    };
  const loadSession = vi
    .fn<typeof toolsEffectiveTestDependencies.loadGatewaySessionEntryReadOnly>()
    .mockReturnValueOnce(loaded)
    .mockReturnValueOnce({
      ...loaded,
      entry: { ...expectDefined(loaded.entry, "session fixture"), inheritedToolDeny: ["exec"] },
    });
  const handler = expectDefined(
    createToolsEffectiveHandlers({
      ...toolsEffectiveTestDependencies,
      loadGatewaySessionEntryReadOnly: loadSession,
    })["tools.effective"],
    "tools.effective handler",
  );
  const invoke = async () => {
    const respond = vi.fn();
    await handler({
      params: { sessionKey },
      respond: respond as never,
      context: { getRuntimeConfig: () => loaded.cfg } as never,
      client: null,
      req: { type: "req", id: "req-policy-refresh", method: "tools.effective" },
      isWebchatConnect: () => false,
    });
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    return respond.mock.calls[0]?.[1];
  };

  const first = await invoke();
  inventoryMocks.resolveEffectiveToolInventory.mockReturnValueOnce({
    agentId: "main",
    profile: "coding",
    groups: [],
  });
  const second = await invoke();

  expect(first).toMatchObject({ groups: [{ tools: [{ id: "exec" }] }] });
  expect(second).toMatchObject({ groups: [] });
  expect(inventoryMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(2);
  expect(
    inventoryMocks.resolveEffectiveToolInventory.mock.calls[1]?.[0].conversationCapabilityProfile,
  ).toMatchObject({ policy: { inheritedToolPolicy: { deny: ["exec"] } } });
});
