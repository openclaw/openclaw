import { expectTypeOf } from "vitest";
import type {
  ChannelGatewayAdapterV2,
  ChannelGatewayContext,
  ChannelGatewayContextV2,
} from "../../src/plugin-sdk/channel-contract.js";
import type { ChannelPlugin } from "../../src/plugin-sdk/channel-core.js";
import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  OpenClawPluginServiceContextV2,
  OpenClawPluginServiceV2,
  PluginServiceSchedulerV1,
} from "../../src/plugin-sdk/plugin-entry.js";
import type { OpenClawPluginChannelRegistration } from "../../src/plugins/plugin-registration.types.js";

type ChannelGatewayAdapter = NonNullable<ChannelPlugin<unknown>["gateway"]>;
type Account = { accountId: string; token: string };
type Probe = { online: boolean };
type Audit = { count: number };

// Compile-only coverage for published V1 calls and inferred registration callbacks.
async function verifyChannelRegistrationTypes(params: {
  api: Pick<OpenClawPluginApi, "registerChannel">;
  base: Pick<ChannelPlugin<Account>, "id" | "meta" | "capabilities" | "config">;
  legacyContext: Omit<ChannelGatewayContext<Account>, "scheduler">;
  contextV2: ChannelGatewayContextV2<Account>;
  registration: OpenClawPluginChannelRegistration | ChannelPlugin;
}) {
  const { api, base, legacyContext, contextV2 } = params;
  const pluginV1: ChannelPlugin<Account> = {
    ...base,
    gateway: {
      async startAccount(ctx) {
        const token: string = ctx.account.token;
        return token;
      },
    },
  };
  await pluginV1.gateway?.startAccount?.(legacyContext);
  const legacyRegistration: OpenClawPluginChannelRegistration = { plugin: pluginV1 };
  await legacyRegistration.plugin.gateway?.startAccount?.(legacyContext);
  const pluginV2: ChannelPlugin<Account, unknown, unknown, 2> = {
    ...base,
    gateway: {
      apiVersion: 2,
      async startAccount(ctx) {
        const owner: PluginServiceSchedulerV1 = ctx.scheduler;
        return owner.now();
      },
    },
  };
  await pluginV2.gateway?.startAccount?.(contextV2);
  expectTypeOf(legacyContext).not.toMatchTypeOf<
    Parameters<NonNullable<NonNullable<typeof pluginV2.gateway>["startAccount"]>>[0]
  >();
  const status: NonNullable<ChannelPlugin<Account, Probe, Audit>["status"]> = {
    probeAccount: async () => ({ online: true }),
    auditAccount: async ({ probe }) => ({ count: probe?.online ? 1 : 0 }),
    buildAccountSnapshot({ account, probe, audit }) {
      expectTypeOf(probe).toEqualTypeOf<Probe | undefined>();
      expectTypeOf(audit).toEqualTypeOf<Audit | undefined>();
      return {
        accountId: account.accountId,
        connected: probe?.online,
        lastError: audit?.count.toString(),
      };
    },
  };
  const probedV1: ChannelPlugin<Account, Probe, Audit> = { ...pluginV1, status };
  const probedV2: ChannelPlugin<Account, Probe, Audit, 2> = { ...pluginV2, status };
  const registrationV2: OpenClawPluginChannelRegistration<typeof probedV2> = { plugin: probedV2 };
  await registrationV2.plugin.gateway?.startAccount?.(contextV2);
  expectTypeOf(legacyContext).not.toMatchTypeOf<
    Parameters<NonNullable<NonNullable<typeof registrationV2.plugin.gateway>["startAccount"]>>[0]
  >();
  api.registerChannel(registrationV2);
  api.registerChannel(probedV1);
  api.registerChannel({ plugin: probedV2 });
  const legacy: ChannelGatewayAdapter = {
    async startAccount({ accountId, scheduler }) {
      return { accountId, now: scheduler?.now() };
    },
  };
  await legacy.startAccount?.(legacyContext);
  const current: ChannelGatewayAdapterV2 = {
    apiVersion: 2,
    async startAccount({ scheduler }) {
      return scheduler.now();
    },
  };
  await current.startAccount?.(contextV2);
  expectTypeOf(legacyContext).not.toMatchTypeOf<
    Parameters<NonNullable<typeof current.startAccount>>[0]
  >();
  api.registerChannel({ ...base, gateway: legacy });
  api.registerChannel({ plugin: { ...base, gateway: current } });
  api.registerChannel(params.registration);
  api.registerChannel({
    ...base,
    gateway: {
      async startAccount({ accountId, scheduler }) {
        return { accountId, now: scheduler?.now() };
      },
    },
  });
  api.registerChannel({
    plugin: {
      ...base,
      gateway: {
        async startAccount({ accountId, abortSignal, setStatus }) {
          setStatus({ accountId, running: !abortSignal.aborted });
        },
      },
    },
  });
  api.registerChannel({
    ...base,
    gateway: {
      apiVersion: 2,
      async startAccount({ scheduler }) {
        const owner: PluginServiceSchedulerV1 = scheduler;
        return owner.now();
      },
    },
  });
  api.registerChannel({
    plugin: {
      ...base,
      gateway: {
        apiVersion: 2,
        async startAccount({ scheduler }) {
          const owner: PluginServiceSchedulerV1 = scheduler;
          return owner.now();
        },
      },
    },
  });
}

async function verifyServiceRegistrationTypes(params: {
  api: Pick<OpenClawPluginApi, "registerService">;
  legacyContext: Omit<OpenClawPluginServiceContext, "scheduler">;
  contextV2: OpenClawPluginServiceContextV2;
  service: OpenClawPluginService | OpenClawPluginServiceV2;
}) {
  const { api, legacyContext, contextV2 } = params;
  const legacy: OpenClawPluginService = {
    id: "legacy",
    start(ctx) {
      ctx.logger.info(ctx.stateDir);
    },
  };
  await legacy.start(legacyContext);
  const current: OpenClawPluginServiceV2 = {
    id: "current",
    apiVersion: 2,
    start(ctx) {
      const owner: PluginServiceSchedulerV1 = ctx.scheduler;
      owner.now();
    },
  };
  await current.start(contextV2);
  expectTypeOf(legacyContext).not.toMatchTypeOf<Parameters<typeof current.start>[0]>();
  api.registerService(params.service);
  api.registerService({
    id: "inline-legacy",
    start(ctx) {
      ctx.logger.info(ctx.stateDir);
      ctx.scheduler?.now();
    },
  });
  api.registerService({
    id: "inline-current",
    apiVersion: 2,
    start(ctx) {
      const owner: PluginServiceSchedulerV1 = ctx.scheduler;
      owner.now();
    },
  });
}

void verifyChannelRegistrationTypes;
void verifyServiceRegistrationTypes;
