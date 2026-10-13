import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  createGatewayToolCallerWrapper,
  getGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { createScreenTool } from "../../agents/tools/screen-tool.js";
import {
  callPersonalToolUiCommand as call,
  withPersonalToolTurn,
} from "../../auto-reply/reply/personal-tool-turn.test-support.js";
import type { GatewayClient } from "./types.js";

function client(
  connId: string,
  id: string = GATEWAY_CLIENT_IDS.CONTROL_UI,
  caps: string[] = [GATEWAY_CLIENT_CAPS.UI_COMMANDS],
  profileId?: string,
): GatewayClient {
  return {
    connId,
    ...(profileId
      ? {
          authenticatedUserProfile: {
            profileId,
            displayName: null,
            hasAvatar: false,
            updatedAt: 1,
          },
        }
      : {}),
    connect: {
      client: { id, version: "test", platform: "web", mode: "ui" },
      caps,
    },
  } as GatewayClient;
}

describe("ui.command gateway method", () => {
  it("rejects invalid params", async () => {
    const result = await call({ command: { kind: "sidebar", visible: "yes" } }, []);

    expect(result.respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(result.broadcastToConnIds).not.toHaveBeenCalled();
  });

  it("reports when no capable Control UI client is connected", async () => {
    const requester = client("legacy-ui", GATEWAY_CLIENT_IDS.CONTROL_UI, []);
    const result = await call(
      { command: { kind: "sidebar", visible: true } },
      [requester, client("capable-cli", GATEWAY_CLIENT_IDS.CLI)],
      requester,
    );

    expect(result.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
    expect(result.broadcastToConnIds).not.toHaveBeenCalled();
  });

  it("navigates only the requester, even when another user and another tab share the session", async () => {
    const params = {
      command: { kind: "navigate", sessionKey: "agent:main:other" },
      sessionKey: "agent:main:main",
    };
    const requester = client("alice-tab-one", undefined, undefined, "alice");
    const result = await call(
      params,
      [
        requester,
        client("alice-tab-two", undefined, undefined, "alice"),
        client("bob-tab", undefined, undefined, "bob"),
        client("legacy-ui", GATEWAY_CLIENT_IDS.CONTROL_UI, []),
        client("cli", GATEWAY_CLIENT_IDS.CLI),
      ],
      requester,
    );

    expect(result.broadcastToConnIds).toHaveBeenCalledWith(
      "ui.command",
      {
        ...params,
        agentId: "main",
        sessionKey: "agent:main:other",
      },
      new Set(["alice-tab-one"]),
    );
    expect(result.respond).toHaveBeenCalledWith(true, { ok: true });
  });

  it("delivers plugin panel commands only to the requester", async () => {
    const requester = client("requester");
    const params = {
      sessionKey: "agent:main:main",
      command: {
        kind: "panel",
        panel: "plugin",
        pluginId: "review",
        panelId: "document",
        open: true,
      },
    };
    const result = await call(params, [requester, client("bystander")], requester);
    expect(result.respond).toHaveBeenCalledWith(true, { ok: true });
    expect(result.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
      "ui.command",
      { ...params, agentId: "main" },
      new Set(["requester"]),
    );
  });

  it("keeps the agent screen tool bound to its requesting browser across async execution", async () => {
    const requester = client("requester");
    const recipients = [requester, client("bystander")];
    const deliveries: Set<string>[] = [];
    const screen = createGatewayToolCallerWrapper("main", {
      agentSessionKey: "agent:main:main",
      gatewayUiCommandTarget: { connId: requester.connId! },
    })(
      createScreenTool({
        agentSessionKey: "agent:main:main",
        callGateway: async <T>(_method: string, params: Record<string, unknown>): Promise<T> => {
          await Promise.resolve();
          const result = await call(params, recipients);
          expect(result.respond).toHaveBeenCalledWith(true, { ok: true });
          const delivery = expectDefined(result.broadcastToConnIds.mock.calls[0], "UI delivery");
          deliveries.push(delivery[2]);
          return { ok: true } as T;
        },
      }),
    );

    await screen.execute("select", { action: "navigate", sessionKey: "agent:main:selected" });

    expect(deliveries).toEqual([new Set(["requester"])]);
  });

  it.each([
    { backendKind: "embedded", hiddenQuestion: false },
    { backendKind: "cli", hiddenQuestion: false },
    { backendKind: "embedded", hiddenQuestion: true },
  ] as const)(
    "routes personal screen requests only to the selected accepted $backendKind turn participant (hidden question: $hiddenQuestion)",
    async ({ backendKind, hiddenQuestion }) => {
      const owner = {
        profileId: "alice",
        senderId: "alice-sender",
        name: "Alice",
        gatewayUiCommandTarget: { connId: "alice-tab", profileId: "alice" },
      };
      const steerer = {
        profileId: "bob",
        senderId: "bob-sender",
        name: "Bob",
        gatewayUiCommandTarget: { connId: "bob-tab", profileId: "bob" },
      };
      const recipients = [
        client("alice-tab", undefined, undefined, owner.profileId),
        client("bob-tab", undefined, undefined, steerer.profileId),
        client("bob-other-tab", undefined, undefined, steerer.profileId),
      ];
      const results: Awaited<ReturnType<typeof call>>[] = [];
      const screen = createScreenTool({
        callGateway: async <T>(_method: string, params: Record<string, unknown>): Promise<T> => {
          await Promise.resolve();
          const result = await call(params, recipients);
          results.push(result);
          return { ok: true } as T;
        },
      });
      const execute = async (user?: string) => {
        await screen.execute("screen", { action: "sidebar_hide", ...(user ? { user } : {}) });
        return expectDefined(results.at(-1), "screen handler result");
      };
      const expectTarget = (result: Awaited<ReturnType<typeof call>>, connId: string) => {
        expect(result.respond).toHaveBeenCalledWith(true, { ok: true });
        expect(result.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
          "ui.command",
          { command: { kind: "sidebar", visible: false } },
          new Set([connId]),
        );
      };
      const expectRejected = (result: Awaited<ReturnType<typeof call>>, message?: string) => {
        expect(result.respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "INVALID_REQUEST",
            ...(message ? { message: expect.stringContaining(message) } : {}),
          }),
        );
        expect(result.broadcastToConnIds).not.toHaveBeenCalled();
      };

      await withPersonalToolTurn({ owner, backendKind, hiddenQuestion }, async (turn) => {
        const { resolve } = expectDefined(
          turn.operation.personalToolParticipants,
          "turn participants",
        );
        const selectedOwner = expectDefined(resolve(), "turn owner");
        expectTarget(await execute(), "alice-tab");
        expectTarget(await execute(owner.profileId), "alice-tab");
        expectRejected(await execute(owner.senderId), "Alice (user: alice)");
        expectRejected(await execute(steerer.profileId));

        expect(await turn.steer(steerer, { scopes: ["operator.read"] })).toMatchObject({
          status: "rejected",
          reason: hiddenQuestion ? "input_visibility_mismatch" : "tool_authority_mismatch",
        });
        expectTarget(await execute(), "alice-tab");
        expectRejected(await execute(steerer.profileId));
        expect(await turn.steer(steerer, { reject: true })).toMatchObject({
          status: "rejected",
          reason: "runtime_rejected",
        });
        expectTarget(await execute(), "alice-tab");

        expect(await turn.steer(steerer)).toMatchObject({ status: "accepted" });
        expect(() => selectedOwner.assertCurrent()).toThrow("Alice (user: alice)");
        const ambiguous = await execute();
        expectRejected(ambiguous, "Alice (user: alice)");
        expectRejected(ambiguous, "Bob (user: bob)");
        expectTarget(await execute(steerer.profileId), "bob-tab");
        expectTarget(await execute(owner.profileId), "alice-tab");
        const unknown = await execute("nonparticipant");
        expectRejected(unknown, "Alice (user: alice)");
        expectRejected(unknown, "Bob (user: bob)");
        expectRejected(await execute(steerer.senderId), "Bob (user: bob)");

        expect(
          await turn.steer({
            ...steerer,
            gatewayUiCommandTarget: { connId: "bob-other-tab", profileId: "bob" },
          }),
        ).toMatchObject({ status: "accepted" });
        expectTarget(await execute(steerer.profileId), "bob-other-tab");
        expect(turn.releaseCounts.get(steerer.profileId)).toBe(1);

        turn.revoke(steerer.profileId);
        expectRejected(await execute(steerer.profileId), "Bob's access changed; ask them again");
        expectTarget(await execute(owner.profileId), "alice-tab");
        turn.complete();
        expect(turn.releaseCounts.get(steerer.profileId)).toBe(2);
        expectRejected(await execute(owner.profileId));
      });
    },
  );

  it("resolves an identity-only request through its exact registered turn participant owner", async () => {
    const owner = {
      profileId: "alice",
      senderId: "alice-sender",
      name: "Alice",
      gatewayUiCommandTarget: { connId: "alice-tab", profileId: "alice" },
    };
    const steerer = {
      profileId: "bob",
      senderId: "bob-sender",
      name: "Bob",
      gatewayUiCommandTarget: { connId: "bob-tab", profileId: "bob" },
    };
    const recipients = [
      client("alice-tab", undefined, undefined, "alice"),
      client("bob-tab", undefined, undefined, "bob"),
    ];
    await withPersonalToolTurn({ owner }, async (turn) => {
      const runtimeClient = client("runtime", GATEWAY_CLIENT_IDS.GATEWAY_CLIENT);
      runtimeClient.internal = {
        syntheticClient: true,
        agentRuntimeIdentity: turn.runtimeIdentity,
      };
      const request = () =>
        withoutGatewayToolCallerIdentity(() => {
          expect(getGatewayToolCallerIdentity()).toBeUndefined();
          return call({ command: { kind: "sidebar", visible: false } }, recipients, runtimeClient);
        });
      const original = await request();
      expect(original.broadcastToConnIds).toHaveBeenCalledWith(
        "ui.command",
        expect.any(Object),
        new Set(["alice-tab"]),
      );
      for (const mismatch of [
        { sessionKey: "agent:main:other" },
        { agentId: "other" },
        {
          operationalRunInstance: {
            ...turn.runtimeIdentity.operationalRunInstance,
            instanceId: "other-instance",
          },
        },
      ]) {
        runtimeClient.internal.agentRuntimeIdentity = { ...turn.runtimeIdentity, ...mismatch };
        const rejected = await request();
        expect(rejected.respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
        expect(rejected.broadcastToConnIds).not.toHaveBeenCalled();
      }
      runtimeClient.internal.agentRuntimeIdentity = turn.runtimeIdentity;
      expect(await turn.steer(steerer)).toMatchObject({ status: "accepted" });
      const ambiguous = await request();
      expect(ambiguous.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message: expect.stringMatching(/Alice \(user: alice\).*Bob \(user: bob\)/),
        }),
      );
      expect(ambiguous.broadcastToConnIds).not.toHaveBeenCalled();
      turn.complete();
      const ended = await request();
      expect(ended.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(ended.broadcastToConnIds).not.toHaveBeenCalled();
    });
  });

  it.each([
    "missing",
    "disconnected",
    "invalidated",
    "retired",
    "synthetic",
    "backend",
    "different-profile",
  ])("does not redirect a %s requester to another browser", async (state) => {
    const requester = client("requester", undefined, undefined, "alice");
    if (state === "synthetic") {
      requester.internal = { syntheticClient: true };
    }
    if (state === "backend") {
      requester.connect.client.id = GATEWAY_CLIENT_IDS.GATEWAY_CLIENT;
    }
    const recipient = {
      ...requester,
      ...(state === "invalidated" ? { invalidated: true } : {}),
      ...(state === "retired" ? { connectionSignal: AbortSignal.abort() } : {}),
      ...(state === "different-profile"
        ? {
            authenticatedUserProfile: client("requester", undefined, undefined, "bob")
              .authenticatedUserProfile,
          }
        : {}),
    };
    const result = await call(
      { command: { kind: "navigate", sessionKey: "agent:main:selected" } },
      [client("bystander"), ...(state === "disconnected" ? [] : [recipient])],
      state === "missing" ? undefined : requester,
    );

    expect(result.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
    expect(result.broadcastToConnIds).not.toHaveBeenCalled();
  });

  it("rejects caller-supplied browser targeting in RPC params", async () => {
    const requester = client("requester");
    const result = await call(
      {
        command: { kind: "sidebar", visible: true },
        gatewayUiCommandTarget: { connId: "bystander" },
      },
      [requester, client("bystander")],
      requester,
    );

    expect(result.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(result.broadcastToConnIds).not.toHaveBeenCalled();
  });
});
