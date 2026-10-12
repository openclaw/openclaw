import type { GatewayRequestHandlerOptions as CoreHandler } from "openclaw/plugin-sdk/core";
import type { GatewayRequestHandlerOptions as RuntimeHandler } from "openclaw/plugin-sdk/gateway-runtime";
import type { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import { expectTypeOf, it } from "vitest";
import type {
  UsersAuthConnectStatusResult,
  UsersLinkAuthProfileResult,
  UsersListAuthLinksResult,
  UsersListModelAccountsResult,
  UsersSelectModelAccountResult,
  UsersUnlinkAuthProfileResult,
} from "../../packages/gateway-protocol/src/schema/users.js";

it("retains all seven synchronous account contracts from v2026.9.8 with awaited replacements", () => {
  type Context = CoreHandler["context"];
  expectTypeOf<RuntimeHandler["context"]>().toEqualTypeOf<Context>();
  expectTypeOf<
    NonNullable<NonNullable<ReturnType<typeof getPluginRuntimeGatewayRequestScope>>["context"]>
  >().toEqualTypeOf<Context>();
  type Service = NonNullable<Context["modelAccountConnectService"]>;
  type ReleasedAction = { owner: string; assertCurrent: () => void };
  type ReleasedService = {
    listLinks: (action: ReleasedAction) => UsersListAuthLinksResult;
    link: (action: ReleasedAction, authProfileId: string) => UsersLinkAuthProfileResult;
    unlink: (action: ReleasedAction, provider: string) => UsersUnlinkAuthProfileResult;
    list: (action: ReleasedAction, cursor?: string) => UsersListModelAccountsResult;
    select: (action: ReleasedAction, authProfileId: string) => UsersSelectModelAccountResult;
    status: (action: ReleasedAction, connectId: string) => UsersAuthConnectStatusResult;
    cancel: (action: ReleasedAction, connectId: string) => UsersAuthConnectStatusResult;
  };
  type AsyncService = {
    [Method in keyof ReleasedService as `${Method}Async`]: (
      ...args: Parameters<ReleasedService[Method]>
    ) => Promise<ReturnType<ReleasedService[Method]>>;
  };
  type ReleasedResults = {
    [Method in keyof ReleasedService]: ReturnType<ReleasedService[Method]>;
  };
  type SyncResults = { [Method in keyof ReleasedService]: ReturnType<Service[Method]> };
  type AsyncResults = {
    [Method in keyof ReleasedService]: ReturnType<Service[`${Method}Async`]>;
  };
  expectTypeOf<Service>().toExtend<ReleasedService>();
  expectTypeOf<Service>().toExtend<AsyncService>();
  expectTypeOf<SyncResults>().toEqualTypeOf<ReleasedResults>();
  expectTypeOf<AsyncResults>().toEqualTypeOf<{
    [Method in keyof ReleasedResults]: Promise<ReleasedResults[Method]>;
  }>();
});
