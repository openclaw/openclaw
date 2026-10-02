import { describe, expect, expectTypeOf, it } from "vitest";
import type { ChannelId } from "../channels/plugins/types.public.js";
import {
  resolveCommandAuthorization,
  resolveStoredModelOverride,
  type CommandAuthorization,
} from "./command-auth-native.js";
import type { GatewayRequestHandlerOptions } from "./gateway-runtime.js";
import { resolveSessionModelRef } from "./model-session-runtime.js";

describe("plugin-sdk/command-auth-native", () => {
  it("keeps prepared host metadata outside public model resolver inputs", () => {
    type PublishedCatalog = NonNullable<
      Awaited<
        ReturnType<
          NonNullable<GatewayRequestHandlerOptions["context"]["readPreparedGatewayModelCatalog"]>
        >
      >
    >;
    expectTypeOf<keyof PublishedCatalog>().toEqualTypeOf<
      "entries" | "pluginRegistry" | "routeVariants"
    >();
    type StoredModelInput = Parameters<typeof resolveStoredModelOverride>[0];
    expectTypeOf<keyof StoredModelInput>().toEqualTypeOf<
      | "loadSessionEntry"
      | "sessionEntry"
      | "sessionStore"
      | "sessionKey"
      | "parentSessionKey"
      | "defaultProvider"
      | "allowPluginNormalization"
    >();
    expectTypeOf<NonNullable<Parameters<typeof resolveSessionModelRef>[3]>>().toEqualTypeOf<{
      allowPluginNormalization?: boolean;
    }>();
    const options = {
      allowPluginNormalization: false,
      manifestPlugins: [
        {
          modelIdNormalization: {
            providers: { example: { aliases: { raw: "injected" } } },
          },
        },
      ],
    };
    const params = {
      defaultProvider: "example",
      sessionEntry: { sessionId: "sdk-model", updatedAt: 1, modelOverride: "raw" },
      ...options,
    };
    expect(resolveStoredModelOverride(params)?.model).toBe("raw");
    expect(
      resolveSessionModelRef(
        { agents: { defaults: { model: "example/raw" } } },
        undefined,
        undefined,
        options,
      ),
    ).toEqual({ provider: "example", model: "raw" });
  });

  it("preserves the native authorization result contract", () => {
    type PublishedAuthorization = {
      providerId?: ChannelId;
      ownerList: string[];
      senderId?: string;
      senderIsOwner: boolean;
      isAuthorizedSender: boolean;
      assertOwnerCurrent?: () => void;
      from?: string;
      to?: string;
    };
    expectTypeOf<CommandAuthorization>().toEqualTypeOf<PublishedAuthorization>();
    expectTypeOf<
      ReturnType<typeof resolveCommandAuthorization>
    >().toEqualTypeOf<PublishedAuthorization>();
    const expected: PublishedAuthorization = {
      providerId: undefined,
      ownerList: ["owner"],
      senderId: "guest",
      senderIsOwner: false,
      isAuthorizedSender: false,
      from: undefined,
      to: undefined,
    };
    const actual = resolveCommandAuthorization({
      ctx: { Provider: "webchat", Surface: "webchat", SenderId: "guest" },
      cfg: { commands: { ownerAllowFrom: ["owner"] } },
      commandAuthorized: true,
    });
    expect(actual).toStrictEqual(expected);
    expect(new Set(Reflect.ownKeys(actual))).toEqual(new Set(Reflect.ownKeys(expected)));
  });
});
