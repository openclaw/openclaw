import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createAdmittedRunOperatorAuthority,
  getAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
  type AdmittedRunContext,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import type { EmbeddedAgentQueueHandle } from "../../agents/embedded-agent-runner/run-state.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { withPreparedEmbeddedRunToolAuthority } from "../../agents/harness/tool-authority.runtime.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import {
  withGatewayToolCallerIdentity,
  withGatewayPersonalToolUser,
} from "../../agents/tools/gateway-caller-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AgentRuntimeIdentity } from "../../gateway/agent-runtime-identity-token.js";
import type { GatewayClient, GatewayContextResolver } from "../../gateway/server-methods/types.js";
import type { GatewayUiCommandTarget } from "../../gateway/ui-command-target.types.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import type { ReplyMessageInjectionOutcome } from "../../sessions/session-controller.contracts.js";
import {
  tryClaimSessionControllerTask,
  type SessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import {
  createTestReplyOperation,
  queueCurrentReplyRunMessage,
} from "./reply-run-registry.test-helpers.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";

export async function callPersonalToolUiCommand(
  params: Record<string, unknown>,
  clients: GatewayClient[],
  requester?: GatewayClient,
) {
  const [{ vi }, { createContext }, { uiCommandHandlers }] = await Promise.all([
    import("vitest"),
    import("../../gateway/server-plugin-in-process-dispatch.test-support.js"),
    import("../../gateway/server-methods/ui-command.js"),
  ]);
  const respond = vi.fn();
  const broadcastToConnIds = vi.fn();
  await uiCommandHandlers["ui.command"]!({
    req: { type: "req", id: "screen", method: "ui.command", params },
    params,
    client: requester ?? null,
    isWebchatConnect: () => false,
    respond,
    context: {
      ...createContext(),
      broadcastToConnIds,
      getClientConnIds: (filter) =>
        new Set(
          clients
            .filter((entry) => filter?.(entry) !== false)
            .flatMap((entry) => (entry.connId ? [entry.connId] : [])),
        ),
    },
  });
  return { respond, broadcastToConnIds };
}

export async function createPersonalToolScreenDispatcher(profileIds: readonly string[]) {
  const [{ GATEWAY_CLIENT_IDS }, { createOperatorClient }] = await Promise.all([
    import("../../../packages/gateway-protocol/src/client-info.js"),
    import("../../gateway/server-plugin-in-process-dispatch.test-support.js"),
  ]);
  const recipients = profileIds.map((profileId) => {
    const client = createOperatorClient({
      profileId,
      caps: ["ui-commands"],
      scopes: ["operator.write"],
    });
    client.connId = `${profileId}-tab`;
    client.connect.client.id = GATEWAY_CLIENT_IDS.CONTROL_UI;
    return client;
  });
  return (user?: string) =>
    withGatewayPersonalToolUser(user, () =>
      callPersonalToolUiCommand({ command: { kind: "sidebar", visible: false } }, recipients),
    );
}

export async function createPersonalThemeToolCaller(
  invoke: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<{ ok: boolean; payload?: unknown; error?: { message: string } }>,
) {
  const [{ vi }, gatewayRequest, { createThemeTool }] = await Promise.all([
    import("vitest"),
    import("../../agents/tools/in-process-gateway.js"),
    import("../../agents/tools/theme-tool.js"),
  ]);
  vi.spyOn(gatewayRequest, "callAgentToolGatewayRequest").mockImplementation(
    async <T>(request: Parameters<typeof gatewayRequest.callAgentToolGatewayRequest>[0]) => {
      const result = await invoke(request.method, request.params as Record<string, unknown>);
      if (!result.ok) {
        throw new Error(result.error?.message);
      }
      return result.payload as T;
    },
  );
  const theme = createThemeTool();
  return async (params: Record<string, unknown>, user?: string) =>
    (await theme.execute("theme", { ...params, ...(user ? { user } : {}) })).details;
}

type Person = {
  profileId: string;
  senderId: string;
  name: string;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  readCurrentRoleFacts?: AdmittedRunOperatorAuthority["readCurrentRoleFacts"];
  gatewayUiCommandTarget?: GatewayUiCommandTarget;
};
type PreparedRun = Pick<EmbeddedAgentQueueHandle, "toolAuthorityFingerprint">;

export async function withPersonalToolTurn<T>(
  params: {
    owner: Person;
    config?: OpenClawConfig;
    backendKind?: "embedded" | "cli";
    hiddenQuestion?: boolean;
    sessionKey?: string;
    sessionId?: string;
    runId?: string;
    allowCollaborativeSteering?: boolean;
    admittedRunContext?: AdmittedRunContext;
    gatewayContextResolver?: GatewayContextResolver;
    controllerInput?: SessionControllerInput;
  },
  test: (turn: {
    steer(
      person: Person,
      options?: { reject?: boolean; scopes?: string[] },
    ): Promise<ReplyMessageInjectionOutcome>;
    revoke(profileId: string): void;
    complete(): Promise<void>;
    operation: ReturnType<typeof createTestReplyOperation>;
    admittedRunContext: AdmittedRunContext;
    runtimeIdentity: AgentRuntimeIdentity;
    releaseCounts: Map<string, number>;
    authorityLeases: Array<{ profileId: string; releases: number }>;
  }) => Promise<T>,
): Promise<T> {
  const revoked = new Set<string>();
  const releaseCounts = new Map<string, number>();
  const authorityLeases: Array<{ profileId: string; releases: number }> = [];
  const run = createQueueTestRun({ prompt: "Arrange my view" });
  const queued = run.run;
  const modelPolicy = prepareOperatorModelPolicy({ cfg: {}, policy: {} });
  const authority = (person: Person, scopes = ["operator.read", "operator.write"]) =>
    person.operatorAuthority ??
    createAdmittedRunOperatorAuthority({
      profileId: person.profileId,
      scopes,
      gatewayAccessGrant: null,
      modelPolicy,
      readCurrentRoleFacts: person.readCurrentRoleFacts,
      assertCurrent() {
        if (revoked.has(person.profileId)) {
          throw new Error("Profile access revoked");
        }
      },
      retain: () => {
        const lease = { profileId: person.profileId, releases: 0 };
        authorityLeases.push(lease);
        return () => {
          lease.releases += 1;
          releaseCounts.set(person.profileId, (releaseCounts.get(person.profileId) ?? 0) + 1);
        };
      },
    });
  run.operatorAuthority = authority(params.owner);
  Object.assign(queued, {
    agentId: "main",
    sessionKey: params.sessionKey ?? "agent:main:personal-tools",
    sessionId: params.sessionId ?? "personal-tools",
    senderId: params.owner.senderId,
    senderName: params.owner.name,
    senderIsOwner: true,
    clientCaps: ["ui-commands"],
    gatewayUiCommandTarget: params.owner.gatewayUiCommandTarget,
    ...(params.allowCollaborativeSteering
      ? {
          messageProvider: "webchat",
          conversationId: params.sessionKey ?? "agent:main:personal-tools",
        }
      : {}),
  });
  const mailboxClaim = params.controllerInput
    ? tryClaimSessionControllerTask(params.controllerInput)
    : undefined;
  if (params.controllerInput && !mailboxClaim) {
    throw new Error("The test turn controller input is not claimable");
  }
  const operation = createTestReplyOperation({
    sessionKey: queued.sessionKey,
    sessionId: queued.sessionId,
    mailboxClaim,
  });
  await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(run));
  const runId = params.runId ?? "personal-tool-run";
  const admission = params.admittedRunContext
    ? undefined
    : prepareSystemAgentRunAdmission(
        params.config ?? {},
        runId,
        "main",
        "personal-tool-test",
        undefined,
        run.operatorAuthority,
      );
  let reject = false;
  let registeredHandle: EmbeddedAgentQueueHandle | undefined;
  const completionRequested = createDeferred();
  let testOutcome: Promise<T> | undefined;
  // Post-turn assertions retain the fixture registration after native execution and custody end.
  const producer = Promise.resolve().then(async () => {
    try {
      const admittedRunContext =
        params.admittedRunContext ?? (await admission!.admit("embedded", "personal-tool-test"));
      const delegatedAuthority = getAdmittedRunDelegatedAuthority(admittedRunContext);
      if (!delegatedAuthority) {
        throw new Error("The test turn was not admitted");
      }
      const caller = {
        agentId: "main",
        sessionKey: queued.sessionKey!,
        operationalRunInstance: admittedRunContext.operationalRunInstance,
        gatewayUiCommandTarget: params.owner.gatewayUiCommandTarget,
      };
      const runtimeIdentity: AgentRuntimeIdentity = {
        ...caller,
        kind: "agentRuntime",
        delegatedAuthority: { ...delegatedAuthority, kind: "local" },
      };
      const runPrepared = async ({ toolAuthorityFingerprint }: PreparedRun) => {
        const handle = createEmbeddedRunHandle({ runId, toolAuthorityFingerprint });
        handle.messageInjectionV2 = {
          version: 2,
          isAvailable: () => true,
          queueMessage: async (_text, options, assertCurrent) => {
            assertCurrent();
            if (params.hiddenQuestion) {
              throw new Error("Hidden input must claim its pending question");
            }
            if (reject) {
              throw new Error("Runtime declined steering");
            }
            options?.onQueueAccepted?.(true);
          },
        };
        if (params.hiddenQuestion) {
          handle.messageInjectionV2.claimPendingUserInputAnswer = async (
            _text,
            _options,
            assertCurrent,
          ) => {
            assertCurrent();
            return !reject;
          };
        }
        const backend = {
          ...handle,
          ...(params.backendKind === "cli"
            ? { kind: "cli" as const }
            : { kind: "embedded" as const }),
          cancel() {},
        };
        operation.attachBackend(backend);
        if (backend.kind === "embedded") {
          registeredHandle = backend;
          setActiveEmbeddedRun(
            queued.sessionId,
            backend,
            queued.sessionKey,
            queued.sessionFile,
            "main",
          );
        }
        operation.setPhase("running");
        if (params.hiddenQuestion) {
          registerAgentRunContext(runId, {
            isControlUiVisible: false,
            projectSessionMessages: false,
          });
        }
        testOutcome = test({
          operation,
          admittedRunContext,
          runtimeIdentity,
          releaseCounts,
          authorityLeases,
          complete: async () => {
            operation.complete();
            completionRequested.resolve();
            await producer;
          },
          revoke: (profileId) => {
            revoked.add(profileId);
          },
          steer: async (person, options) => {
            reject = options?.reject === true;
            return await queueCurrentReplyRunMessage(queued.sessionId, "Change my view", {
              isInboundUserMessage: true,
              allowCollaborativeSteering: params.allowCollaborativeSteering,
              toolAuthorityOverlay: {
                sessionKey: queued.sessionKey,
                ...(params.allowCollaborativeSteering
                  ? {
                      messageProvider: queued.messageProvider,
                      conversationId: queued.conversationId ?? undefined,
                    }
                  : {}),
                operatorAuthority: authority(person, options?.scopes),
                senderId: person.senderId,
                senderName: person.name,
                senderIsOwner: true,
                disableTools: false,
                traceAuthorized: false,
                clientCaps: queued.clientCaps,
                gatewayUiCommandTarget: person.gatewayUiCommandTarget,
              },
            });
          },
        });
        await Promise.race([testOutcome, completionRequested.promise]);
      };
      await withGatewayToolCallerIdentity(
        {
          ...caller,
          operatorAuthority: run.operatorAuthority,
          executionIdentityToken: admittedRunContext.executionIdentityToken,
          gatewayContextResolver: params.gatewayContextResolver,
          receiptAuthority: () => {
            if (getAdmittedRunDelegatedAuthority(admittedRunContext) !== delegatedAuthority) {
              throw new Error("The test turn is no longer admitted");
            }
          },
        },
        () =>
          withPreparedEmbeddedRunToolAuthority(
            { admittedRunContext, replyOperation: operation },
            {
              ...queued,
              runId,
              modelId: queued.model,
              toolAuthorityFingerprint: operation.toolAuthorityFingerprint,
              abortSignal: operation.abortSignal,
            },
            undefined,
            runPrepared,
          ),
      );
    } finally {
      operation.complete();
    }
  });
  try {
    await producer;
    if (!testOutcome) {
      throw new Error("The personal tool producer did not start its test");
    }
    return await testOutcome;
  } finally {
    if (registeredHandle) {
      clearActiveEmbeddedRun(queued.sessionId, registeredHandle, queued.sessionKey);
    }
    if (params.hiddenQuestion) {
      clearAgentRunContext(runId);
    }
    admission?.close();
  }
}
