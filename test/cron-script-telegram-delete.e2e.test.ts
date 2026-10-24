import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { telegramPlugin } from "../extensions/telegram/api.js";
import { loadTelegramDispatchHttpFixture } from "../extensions/telegram/test-api.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import type {
  CronScheduledToolCallerOrigin,
  CronScheduledToolPolicy,
} from "../src/cron/scheduled-tool-policy.js";
import { cronTestDeps } from "../src/cron/service.fixture-builders.test-support.js";
import { CronService } from "../src/cron/service.js";
import { createCronScriptRuntime } from "../src/cron/trigger-script.js";
import type { CronStoredJob } from "../src/cron/types.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../src/gateway/agent-runtime-approval-authority.js";
import { createGatewayMethodRegistry } from "../src/gateway/methods/registry.js";
import type { GatewayRequestContext } from "../src/gateway/server-methods/types.js";
import { createTestPluginRegistry } from "../src/plugins/registry-runtime.test-helpers.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../src/plugins/runtime.js";
import { createBundledPluginRecord } from "../src/plugins/status.test-fixtures.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "./helpers/promise.js";

const { createTelegramDispatchHttpFixture } = await loadTelegramDispatchHttpFixture();
const http = createTelegramDispatchHttpFixture();
const accountId = "account-a";
const otherAccountId = "account-b";
const target = "123";
const messageId = 456;
const ownerSessionKey = `agent:main:telegram:${accountId}:direct:${target}`;
const activeServices = new Set<CronService>();
const providerBindingError =
  "Delegated Telegram message mutation requires a provider-observed binding to the exact current topic and account.";

afterEach(() => {
  for (const service of activeServices) {
    service.stop();
  }
  activeServices.clear();
  clearRuntimeConfigSnapshot();
});

function createConfig(): OpenClawConfig {
  const account = {
    botToken: http.token,
    apiRoot: http.apiRoot,
    actions: { deleteMessage: true },
  };
  return {
    agents: { defaults: { workspace: http.state.stateDir, skipBootstrap: true } },
    session: { store: path.join(http.state.stateDir, "{agentId}", "sessions.json") },
    tools: { allow: ["message"] },
    channels: {
      telegram: {
        defaultAccount: accountId,
        accounts: { [accountId]: account, [otherAccountId]: account },
      },
    },
  };
}

async function createHarness(config: OpenClawConfig) {
  setRuntimeConfigSnapshot(config, config);
  const registryOwner = createTestPluginRegistry();
  const record = createBundledPluginRecord("telegram");
  registryOwner.registry.plugins.push(record);
  registryOwner
    .createApi(record, { config, registrationMode: "full" })
    .registerChannel({ plugin: telegramPlugin });
  const registry = registryOwner.registry;
  setActivePluginRegistry(registry);
  const { sendHandlers } = await import("../src/gateway/server-methods/send.js");
  const messageActionHandler = expectDefined(
    sendHandlers["message.action"],
    "message.action Gateway handler",
  );
  const methods = createGatewayMethodRegistry([
    {
      name: "message.action",
      owner: { kind: "core", area: "message" },
      scope: "operator.write",
      handler: messageActionHandler,
    },
  ]);
  const gatewayContext = {
    getRuntimeConfig: () => config,
    validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    getGatewayMethodRegistry: () => methods,
    trackExecution: <T>(run: () => Promise<T>) => run(),
    dedupe: new Map(),
  } as GatewayRequestContext;
  const scriptRuntime = createCronScriptRuntime({
    config,
    loadPluginRegistry: () => registry,
    resolveGatewayContext: () => gatewayContext,
  });
  const executions: Array<Awaited<ReturnType<typeof scriptRuntime.executePayload>>> = [];
  const cron = new CronService(
    cronTestDeps({
      storePath: path.join(http.state.stateDir, "cron", "jobs.json"),
      defaultAgentId: "main",
      resolveDefaultAgentId: () => "main",
      isAgentAvailable: () => true,
      runScriptJob: async (params) => {
        const execution = await scriptRuntime.executePayload(params);
        executions.push(execution);
        return execution.kind === "error"
          ? { status: "error", error: execution.error }
          : { status: "ok" };
      },
    }),
  );
  activeServices.add(cron);
  return { cron, executions };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function withHarness<T>(run: (harness: Harness) => Promise<T>): Promise<T> {
  const registrySnapshot = captureActivePluginRegistrySnapshot();
  try {
    return await run(await createHarness(createConfig()));
  } finally {
    restoreActivePluginRegistrySnapshot(registrySnapshot);
  }
}

function scriptFor(selectedAccountId = accountId, selectedTarget = target) {
  return `await message({ action: "delete", channel: "telegram", accountId: ${JSON.stringify(selectedAccountId)}, target: ${JSON.stringify(selectedTarget)}, messageId: ${JSON.stringify(String(messageId))} }); return { ok: true };`;
}

async function addDeleteJob(
  cron: CronService,
  params: {
    id: string;
    policy: CronScheduledToolPolicy;
    callerOrigin?: CronScheduledToolCallerOrigin;
    selectedAccountId?: string;
    selectedTarget?: string;
  },
): Promise<CronStoredJob> {
  return await cron.add(
    {
      id: params.id,
      name: params.id,
      agentId: "main",
      owner: { agentId: "main", sessionKey: ownerSessionKey, accountId },
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: {
        kind: "script",
        script: scriptFor(params.selectedAccountId, params.selectedTarget),
        toolsAllow: ["message"],
      },
      delivery: { mode: "none" },
    },
    {
      scheduledToolPolicy: params.policy,
      ...(params.callerOrigin
        ? {
            toolsAllowProvenance: {
              version: 1 as const,
              source: "final-executable-surface" as const,
              callerOrigin: params.callerOrigin,
            },
          }
        : {}),
    },
  );
}

it("deletes through the bundled Telegram adapter from an authorized scheduled script", async () => {
  await withHarness(async ({ cron, executions }) => {
    const job = await addDeleteJob(cron, {
      id: "telegram-delete-trusted",
      policy: { version: 1, mode: "trusted" },
    });

    await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
    expect(executions, JSON.stringify(executions)).toMatchObject([{ kind: "completed" }]);
    expect(http.callsFor("deleteMessage")).toEqual([
      { method: "deleteMessage", fields: { chat_id: target, message_id: messageId } },
    ]);
  });
});

it("hands matching account origin to Telegram without inventing provider context", async () => {
  await withHarness(async ({ cron, executions }) => {
    const job = await addDeleteJob(cron, {
      id: "telegram-delete-account",
      policy: {
        version: 1,
        mode: "account",
        ownerSessionKey,
        ownerAccountId: accountId,
      },
      callerOrigin: { kind: "external", channel: "telegram" },
    });

    await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
    expect(executions, JSON.stringify(executions)).toMatchObject([
      { kind: "error", error: expect.stringContaining(providerBindingError) },
    ]);
    expect(http.calls).toEqual([]);
  });
});

it("rejects mismatched account authority before Telegram mutation I/O", async () => {
  await withHarness(async ({ cron, executions }) => {
    const scenarios: Array<{
      id: string;
      callerOrigin?: CronScheduledToolCallerOrigin;
      selectedAccountId?: string;
      expectedError: string;
    }> = [
      {
        id: "wrong-account",
        callerOrigin: { kind: "external", channel: "telegram" },
        selectedAccountId: otherAccountId,
        expectedError: "cannot use another creator account",
      },
      { id: "missing-origin", expectedError: 'Scheduled account "account-a" is unavailable' },
      {
        id: "unknown-origin",
        callerOrigin: { kind: "unknown" },
        expectedError: 'Scheduled account "account-a" is unavailable',
      },
      {
        id: "wrong-channel-origin",
        callerOrigin: { kind: "external", channel: "slack" },
        expectedError: 'Scheduled account "account-a" is unavailable',
      },
    ];

    for (const scenario of scenarios) {
      const job = await addDeleteJob(cron, {
        id: `telegram-delete-${scenario.id}`,
        policy: {
          version: 1,
          mode: "account",
          ownerSessionKey,
          ownerAccountId: accountId,
        },
        callerOrigin: scenario.callerOrigin,
        selectedAccountId: scenario.selectedAccountId,
      });

      await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
      expect(
        executions.at(-1),
        `${scenario.id}: ${JSON.stringify(executions.at(-1))}`,
      ).toMatchObject({
        kind: "error",
        error: expect.stringContaining(scenario.expectedError),
      });
      expect(http.calls, scenario.id).toEqual([]);
    }
  });
});

async function verifyTrustedAliasDeleteAfterLookup(
  disable: boolean,
  signal: AbortSignal,
): Promise<void> {
  await withHarness(async ({ cron }) => {
    const alias = "@retirement_fixture";
    const held = {
      predicate: (call: { method: string }) => call.method === "getChat",
      arrived: createDeferred(),
      release: createDeferred(),
    };
    http.holdNextCall = held;
    http.respondToCall = (call) => {
      if (call.method === "getChat" && call.fields.chat_id === alias) {
        // Preserve the observed alias request while the fixture returns its numeric chat.
        const responseFields = call.fields;
        call.fields = { ...responseFields };
        responseFields.chat_id = target;
      }
      return undefined;
    };
    const job = await addDeleteJob(cron, {
      id: `telegram-delete-${disable ? "disabled" : "active"}`,
      policy: { version: 1, mode: "trusted" },
      selectedTarget: alias,
    });
    const pendingRun = cron.run(job.id, "force");

    try {
      await withinTest(
        awaitGateBeforeSettlement(
          held.arrived.promise,
          pendingRun,
          "Scheduled delete settled before Telegram target lookup",
        ),
        signal,
      );
      expect(http.callsFor("getChat")).toEqual([{ method: "getChat", fields: { chat_id: alias } }]);

      if (disable) {
        const disabled = await cron.update(job.id, { enabled: false });
        expect(disabled.enabled).toBe(false);
      }
      held.release.resolve();
      await expect(withinTest(pendingRun, signal)).resolves.toEqual({ ok: true, ran: true });

      expect(http.callsFor("deleteMessage")).toEqual(
        disable
          ? []
          : [{ method: "deleteMessage", fields: { chat_id: target, message_id: messageId } }],
      );
    } finally {
      held.release.resolve();
      http.holdNextCall = undefined;
      http.respondToCall = undefined;
      await pendingRun.catch(() => undefined);
    }
  });
}

it("completes a trusted alias delete after lookup while the occurrence is active", async ({
  signal,
}) => {
  await verifyTrustedAliasDeleteAfterLookup(false, signal);
});

it("stops a trusted alias delete after lookup when the occurrence is disabled", async ({
  signal,
}) => {
  await verifyTrustedAliasDeleteAfterLookup(true, signal);
});
