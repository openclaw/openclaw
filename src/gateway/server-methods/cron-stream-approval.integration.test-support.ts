import { access } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getAdmittedRunDelegatedAuthority } from "../../agents/admitted-run-context.js";
import { persistAuthProfileBatch } from "../../agents/auth-profiles/upsert-with-lock.js";
import { AUTOMATIONS_TOOL_NAME } from "../../agents/tools/automations-tool-name.js";
import { withoutGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import {
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalRequest,
  type ExecApprovalRequestPayload,
} from "../../infra/exec-approvals.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { dispatchGatewayRequestInProcess } from "../server-in-process-dispatch.js";
import { createRequestGatewayMethodRegistry } from "../server-methods.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { createExecApprovalHandlers } from "./exec-approval.js";
import {
  cfg,
  stateDir,
  admission,
  inRun,
  createCronFixture,
  type CreatorTransportTools,
  createCreatorTransportTools,
} from "./requester-cron-authority.test-support.js";

type StreamApprovalFixture = {
  tools: CreatorTransportTools;
  read: ReturnType<typeof createCronFixture>["read"];
  manager: ExecApprovalManager;
  takeApproval: (operation: Promise<unknown>) => Promise<ExecApprovalRequest>;
  decide: (id: string, decision: "allow-once" | "deny") => Promise<unknown>;
  setPolicy: (security: "full" | "deny", ask: "off" | "always") => Promise<void>;
  revokeRun: () => void;
  deliveries: ExecApprovalRequest[];
  setConfig: (update: (current: OpenClawConfig) => OpenClawConfig) => void;
};

export function approvedStreamJob() {
  return {
    name: "App log watcher",
    enabled: true,
    schedule: {
      kind: "stream" as const,
      command: [process.execPath, "-e", 'process.stdout.write("synthetic log event\\n")'],
      cwd: stateDir,
    },
    sessionTarget: "current",
    payload: { kind: "agentTurn", message: "Summarize the log event" },
    delivery: { mode: "none" },
  };
}

export async function withStreamApprovalFixture(
  run: (fixture: StreamApprovalFixture) => Promise<void>,
  options: {
    ask?: "off" | "always";
    listConfiguredChannels?: () => Promise<string[]>;
    deliveryAvailable?: boolean;
    turnSourceChannel?: string;
    controlUiAdmin?: boolean;
  } = {},
) {
  vi.stubEnv("OPENAI_API_KEY", undefined);
  vi.stubEnv("OPENAI_OAUTH_TOKEN", undefined);
  await persistAuthProfileBatch({
    stateDir,
    profiles: [
      {
        profileId: "openai:stream-approval-test",
        credential: {
          type: "api_key",
          provider: "openai",
          key: "synthetic-stream-approval-test-key",
        },
      },
    ],
  });
  let config: OpenClawConfig = {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        workspace: stateDir,
        model: "openai/gpt-4.1",
        sandbox: { mode: "off" },
      },
    },
    tools: {
      allow: [AUTOMATIONS_TOOL_NAME, "exec"],
      exec: {
        host: "gateway",
        security: options.ask === "off" ? "full" : "allowlist",
        ask: options.ask ?? "always",
      },
    },
    cron: { triggers: { enabled: true } },
  };
  setRuntimeConfigSnapshot(config);
  const fixture = createCronFixture(options.listConfiguredChannels, config);
  fixture.context.getRuntimeConfig = () => config;
  // The approval and Cron mutation must use the same real state database.
  const manager = new ExecApprovalManager<ExecApprovalRequestPayload>({
    scheduler: createTestGatewayScheduler(),
    persistence: { runtimeEpoch: "stream-approval-fixture" },
    resolveAllowedDecisions: resolveExecApprovalRequestAllowedDecisions,
    validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
  });
  fixture.context.execApprovalManager = manager;
  const deliveries: ExecApprovalRequest[] = [];
  const inbox: ExecApprovalRequest[] = [];
  const operations: Promise<unknown>[] = [];
  let waiter: ReturnType<typeof createDeferred<ExecApprovalRequest>> | undefined;
  fixture.context.forwardExecApprovalRequest = async (event) => {
    deliveries.push(event);
    if (options.deliveryAvailable === false) {
      return false;
    }
    if (waiter) {
      waiter.resolve(event);
      waiter = undefined;
    } else {
      inbox.push(event);
    }
    return true;
  };
  const registry = createRequestGatewayMethodRegistry({
    ...createExecApprovalHandlers(manager, {
      forwarder: {
        handleRequested: fixture.context.forwardExecApprovalRequest,
        handleResolved: async () => {},
        stop: async () => {},
      },
    }),
  });
  fixture.context.getGatewayMethodRegistry = () => registry;
  const operator = createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] });
  const operatorConnId = "stream-native-operator";
  operator.connId = operatorConnId;
  operator.connect.client = {
    ...operator.connect.client,
    id: "openclaw-control-ui",
    mode: "webchat",
  };
  fixture.context.getClientConnIds = (predicate) =>
    new Set(!predicate || predicate(operator) ? [operatorConnId] : []);
  operator.internal = {
    isLocalClient: true,
    authenticatedOperator: true,
    operatorRoleActor: { kind: "system" },
    ...(options.controlUiAdmin ? { controlUiAdmin: true } : {}),
  };
  const rpc = <T>(method: string, params: unknown) =>
    withoutGatewayToolCallerIdentity(() =>
      dispatchGatewayRequestInProcess<T>(method, params, {
        client: operator,
        context: fixture.context,
        methodRegistry: registry,
        hasCurrentClientAuthority: () => true,
      }),
    );
  const setPolicy = async (security: "full" | "deny", ask: "off" | "always") => {
    const previous = await rpc<{ hash: string }>("exec.approvals.get", {});
    await rpc("exec.approvals.set", {
      baseHash: previous.hash,
      file: { version: 1, defaults: { security, ask, askFallback: "full" } },
    });
  };
  try {
    await setPolicy("full", "off");
    const runId = "stream-approval-creator";
    const creatorAdmission = expectDefined(admission(runId, operator), "local stream admission");
    await inRun(runId, creatorAdmission, async (_identity, admitted, creator) => {
      bindGatewayContextResolver(admitted, () => fixture.context);
      try {
        const transport = await createCreatorTransportTools({
          transport: "embedded",
          config,
          admitted,
          creator,
          senderIsOwner: true,
          turnSourceChannel: options.turnSourceChannel,
          gatewayUiCommandTarget: { connId: operatorConnId },
        });
        const tools: CreatorTransportTools = {
          invoke: (name, args) => {
            const operation = transport.invoke(name, args);
            operations.push(operation);
            void operation.catch(() => undefined);
            return operation;
          },
        };
        await run({
          tools,
          read: fixture.read,
          manager,
          deliveries,
          setPolicy,
          setConfig: (update) => {
            config = update(config);
            setRuntimeConfigSnapshot(config);
          },
          decide: (id, decision) => rpc("exec.approval.resolve", { id, decision }),
          revokeRun: () =>
            releaseAgentRunDelegatedAuthority(
              expectDefined(getAdmittedRunDelegatedAuthority(admitted), "active approval run"),
            ),
          takeApproval: async (operation) => {
            const queued = inbox.shift();
            if (queued) {
              return queued;
            }
            waiter = createDeferred<ExecApprovalRequest>();
            return await Promise.race([
              waiter.promise,
              operation.then(() => {
                throw new Error("Stream mutation completed before approval delivery");
              }),
            ]);
          },
        });
      } finally {
        await manager.drain();
        await Promise.allSettled(operations);
        clearGatewayContextResolver(admitted);
      }
    });
  } finally {
    await manager.drain();
  }
}

/** A later exec gets its own approval; neither decision changes the refused watcher. */
export async function expectIndependentExecApproval({
  tools,
  takeApproval,
  decide,
}: Pick<StreamApprovalFixture, "tools" | "takeApproval" | "decide">): Promise<void> {
  const marker = path.join(stateDir, "independently-approved-exec");
  const args = {
    command: `"${process.execPath}" -e 'require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")'`,
  };
  const denied = tools.invoke("exec", args);
  const deniedOutcome = Promise.allSettled([denied]);
  const first = await takeApproval(denied);
  await decide(first.id, "deny");
  await deniedOutcome;
  await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  const allowed = tools.invoke("exec", args);
  const second = await takeApproval(allowed);
  expect(second.id).not.toBe(first.id);
  await decide(second.id, "allow-once");
  await allowed;
  await expect(access(marker)).resolves.toBeUndefined();
}
