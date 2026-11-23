import { expect, it, vi } from "vitest";
import { UI_RAIL_SHORTCUTS_PREFERENCE_KEY as PREF } from "../../../packages/gateway-protocol/src/schema/ui-navigation-preferences.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { serializeGatewayFrame } from "../serialized-json.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import {
  identifiedClient,
  initializeSessionReadContext,
} from "./sessions-read-cache.test-support.js";
import type { GatewayClient, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

it("shares ordered sidebar pins with session RPCs, not rail-only shortcuts, legacy flags or other people", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    let cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const alice = identifiedClient(ensureProfileForEmail("alice@pins.test").id);
    const bob = identifiedClient(ensureProfileForEmail("bob@pins.test").id);
    for (const client of [alice, bob]) {
      client.connect.caps = ["personal-session-pins"];
    }
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const key = (label: string) => `agent:main:${label}`;
    const [a, b, c, nested] = ["a", "b", "c", "nested"].map(key) as [
      string,
      string,
      string,
      string,
    ];
    for (const [i, k] of [a, b, c, nested].entries()) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: k },
        {
          sessionId: k,
          updatedAt: i + 1,
          ...(k === a ? { pinnedAt: 100 } : {}),
          ...(k === nested ? { parentSessionKey: a } : {}),
        },
      );
    }
    const hidden = key("bob-draft");
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: hidden },
      {
        sessionId: hidden,
        updatedAt: 10,
        visibility: "draft",
        createdActor: {
          type: "human",
          source: "profile",
          id: bob.authenticatedUserProfile!.profileId,
        },
      },
    );
    const snoozed = key("asleep");
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: snoozed },
      { sessionId: snoozed, updatedAt: 0, snoozedUntil: Date.now() + 86_400_000 },
    );
    await initializeSessionReadContext(context);
    async function rpc(client: GatewayClient, method: string, params: Record<string, unknown>) {
      const respond = vi.fn<RespondFn>();
      const options: GatewayRequestHandlerOptions = {
        req: { type: "req", id: "pins", method, params },
        acceptsSerializedJson: true,
        client,
        context,
        params,
        respond,
        isWebchatConnect: () => false,
      };
      await handleGatewayRequest(options);
      expect(respond).toHaveBeenCalledTimes(1);
      const [ok, value, error] = respond.mock.calls[0]!;
      if (!ok) {
        throw new Error(error?.message ?? "RPC failed");
      }
      return JSON.parse(
        serializeGatewayFrame({ type: "res", id: "pins", ok, payload: value }).toString(),
      ).payload;
    }
    const shortcuts = [
      `session-rail:${a}`,
      `session:${hidden}`,
      `session:${b}`,
      "route:usage",
      `session:${c}`,
      `session:${nested}`,
    ];
    await rpc(alice, "users.prefs.set", { entries: { [PREF]: shortcuts } });
    await rpc(bob, "users.prefs.set", { entries: { [PREF]: [`session:${a}`] } });
    const list = (client: GatewayClient, params: Record<string, unknown>) =>
      rpc(client, "sessions.list", { agentId: "main", ...params });
    const oldMac: GatewayClient = {
      ...alice,
      connect: {
        ...alice.connect,
        client: { ...alice.connect.client, id: "openclaw-macos", mode: "ui" },
        caps: [],
      },
    };
    await expect(list(oldMac, { pinned: true })).resolves.toMatchObject({
      totalCount: 1,
      sessions: [{ key: a, pinned: true }],
    });
    const integration: GatewayClient = {
      ...alice,
      connect: {
        ...alice.connect,
        client: { ...alice.connect.client, id: "gateway-client", mode: "backend" },
        caps: [],
      },
    };
    await expect(list(integration, { pinned: true })).resolves.toMatchObject({
      sessions: [{ key: a, pinned: true }],
    });
    await expect(
      rpc(integration, "sessions.patch", { key: c, label: "Legacy", pinned: true }),
    ).resolves.toMatchObject({ entry: { label: "Legacy", pinnedAt: expect.any(Number) } });
    await expect(
      rpc(integration, "sessions.patch", { key: c, pinned: false }),
    ).resolves.toMatchObject({ key: c });
    integration.connect.caps = ["personal-session-pins"];
    await expect(list(integration, { pinned: true })).resolves.toMatchObject({
      sessions: [{ key: b }, { key: c }],
    });
    await expect(
      rpc(integration, "sessions.patch", { key: c, label: "Mixed", pinned: true }),
    ).rejects.toThrow(/pinned separately/);
    const modernMac: GatewayClient = {
      ...oldMac,
      connect: { ...oldMac.connect, caps: ["personal-session-pins"] },
    };
    await expect(list(modernMac, { pinned: true })).resolves.toMatchObject({
      totalCount: 2,
      sessions: [{ key: b }, { key: c }],
    });
    await expect(rpc(alice, "sessions.patch", { key: snoozed, pinned: true })).rejects.toThrow(
      /wake.*first/i,
    );
    await expect(list(alice, { pinned: true, limit: 1 })).resolves.toMatchObject({
      totalCount: 2,
      nextOffset: 1,
      sessions: [{ key: b, pinned: true }],
    });
    await expect(
      list(alice, { pinned: true, sortBy: "activity", offset: 1 }),
    ).resolves.toMatchObject({ totalCount: 2, sessions: [{ key: c, pinned: true }] });
    for (const includeNativeSubagents of [false, true]) {
      const params = { key: a, agentId: "main", includeNativeSubagents };
      await expect(rpc(alice, "sessions.describe", params)).resolves.toMatchObject({
        session: { key: a, pinned: false },
      });
      await expect(rpc(bob, "sessions.describe", params)).resolves.toMatchObject({
        session: { key: a, pinned: true },
      });
    }
    // The actual preference writer must not evict someone else's warm menu on a theme change.
    await rpc(bob, "users.prefs.set", { entries: { "ui.theme": "dark" } });
    const preferenceReads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    try {
      await expect(list(alice, { pinned: true })).resolves.toMatchObject({
        totalCount: 2,
        sessions: [{ key: b }, { key: c }],
      });
      expect(
        preferenceReads.mock.calls.filter(([, op]) => op.type.startsWith("userPreferences.")),
      ).toEqual([]);
    } finally {
      preferenceReads.mockRestore();
    }
    await expect(list(bob, { pinned: true })).resolves.toMatchObject({
      sessions: [{ key: a, pinned: true }],
    });
    await expect(list(alice, { pinned: false })).resolves.toMatchObject({
      sessions: [
        { key: nested, pinned: false },
        { key: a, pinned: false },
        { key: snoozed, pinned: false },
      ],
    });
    await expect(list(alice, { limit: 2 })).resolves.toMatchObject({
      sessions: [
        { key: b, pinned: true },
        { key: c, pinned: true },
      ],
    });
    await rpc(alice, "users.prefs.set", { entries: { [PREF]: shortcuts.toReversed() } });
    await expect(list(alice, { pinned: true, limit: 1 })).resolves.toMatchObject({
      sessions: [{ key: c, pinned: true }],
    });
    await rpc(alice, "users.prefs.set", { entries: { [PREF]: shortcuts } });
    await expect(
      rpc(alice, "sessions.patch", { key: a, pinned: true, label: "not written" }),
    ).rejects.toThrow(/separately/);
    expect(loadSessionEntry({ agentId: "main", sessionKey: a })?.label).toBeUndefined();
    await expect(
      rpc(alice, "sessions.patch", { key: a, pinned: true, expectedSessionId: "replaced" }),
    ).rejects.toThrow(/changed/);
    await expect(rpc(alice, "sessions.patch", { key: hidden, pinned: true })).rejects.toThrow(
      /not found|visible|draft/i,
    );
    await expect(rpc(alice, "sessions.patch", { key: a, pinned: true })).resolves.toMatchObject({
      entry: { sessionId: a, pinned: true },
    });
    // An earlier sidebar drag cannot overwrite a subsequently committed tool pin.
    await expect(
      rpc(alice, "users.prefs.set", {
        entries: { [PREF]: shortcuts.toReversed() },
        expectedEntries: { [PREF]: shortcuts },
      }),
    ).resolves.toEqual({ status: "conflict" });
    await rpc(alice, "sessions.patchMany", {
      targets: [{ key: b }, { key: c }],
      patch: { pinned: false },
    });
    await expect(rpc(alice, "users.prefs.get", { keys: [PREF] })).resolves.toEqual({
      status: "ok",
      entries: {
        [PREF]: [
          `session-rail:${a}`,
          `session:${hidden}`,
          "route:usage",
          `session:${nested}`,
          `session:${a}`,
        ],
      },
    });
    await expect(rpc(alice, "sessions.patch", { key: nested, pinned: true })).rejects.toThrow(
      /child|nested/,
    );
    await expect(
      rpc(alice, "sessions.patchMany", {
        targets: [{ key: b }, { key: c, expectedSessionId: "replacement" }],
        patch: { pinned: true },
      }),
    ).resolves.toMatchObject({
      outcomes: [
        { key: b, ok: true },
        { key: c, ok: false },
      ],
    });
    await expect(
      rpc(alice, "sessions.patch", { key: "agent:main:missing-pin", pinned: true }),
    ).rejects.toThrow(/not found|changed|visible/i);
    expect(
      loadSessionEntry({ agentId: "main", sessionKey: "agent:main:missing-pin" }),
    ).toBeUndefined();
    await rpc(alice, "sessions.patch", { key: a, pinned: false });
    await expect(list(bob, { pinned: true })).resolves.toMatchObject({
      sessions: [{ key: a, pinned: true }],
    });
    expect(loadSessionEntry({ agentId: "main", sessionKey: a })?.pinnedAt).toBe(100);
    // With global session scope, main is a real root stored in the sidebar's session:global slot.
    cfg = { ...cfg, session: { scope: "global" } };
    setRuntimeConfigSnapshot(cfg);
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "global" },
      { sessionId: "global-root", updatedAt: 1 },
    );
    await expect(
      rpc(alice, "sessions.patch", {
        key: "main",
        agentId: "main",
        pinned: true,
        expectedSessionId: "global-root",
      }),
    ).resolves.toMatchObject({ entry: { pinned: true } });
    await expect(rpc(alice, "users.prefs.get", { keys: [PREF] })).resolves.toMatchObject({
      entries: { [PREF]: expect.arrayContaining(["session:global"]) },
    });
    await expect(
      rpc(alice, "sessions.patch", {
        key: "global",
        agentId: "main",
        pinned: false,
        expectedSessionId: "global-root",
      }),
    ).resolves.toMatchObject({ entry: { pinned: false } });
    const anonymous: GatewayClient = { connect: alice.connect };
    await expect(list(anonymous, { pinned: false })).rejects.toThrow(/profile|requester/i);
    await expect(rpc(anonymous, "sessions.patch", { key: b, pinned: true })).rejects.toThrow(
      /profile|requester/i,
    );
  });
});
