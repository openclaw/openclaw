import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { runLocalAgentCommand } from "../agents/agent-command-local.js";
import { agentCommandFromSystem } from "../agents/agent-command.js";
import { readAgentRunTerminalOutcome } from "../channels/turn/agent-run-terminal-outcome.js";
import { getRuntimeConfig } from "../config/config.js";
import { withLocalGatewayRequestScope } from "../gateway/local-request-context.js";
import { completeAgentOnboarding } from "../gateway/server-methods/agents-onboarding.js";
import { publishTemplateInstallEvent } from "../gateway/server-methods/templates-add-conversation.js";
import type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { withoutRuntimeOutput, type RuntimeEnv } from "../runtime.js";
import { formatTemplateInstallOutcome } from "../shared/template-install-notice.js";
import type { StatelessTemplateAddOptions } from "../templates/add-stateless.js";
import { TemplateAddMutationError } from "../templates/add.js";
import { TEMPLATE_AGENT_OPENING_MESSAGE } from "../templates/conversation.js";
import { createDefaultDeps } from "./deps.js";

/** Offline custody stays with the CLI; session and model effects keep their ordinary owners. */
export function createLocalTemplateConversationAdapters(params: {
  agentId: string;
  assertCurrent: () => void;
  signal: AbortSignal;
  runtime: RuntimeEnv;
}): Pick<
  StatelessTemplateAddOptions,
  "prepareAgentSession" | "waitForAgentRuntime" | "onAgentReady" | "onSetupEvent"
> {
  const deps = createDefaultDeps();
  const withSessionOwner = async <T>(run: (options: GatewayRequestHandlerOptions) => Promise<T>) =>
    withLocalGatewayRequestScope({ deps, getRuntimeConfig }, async () => {
      params.assertCurrent();
      const context = getPluginRuntimeGatewayRequestScope()?.context;
      if (!context?.localEmbedded) {
        throw new Error("Template CLI conversation requires its admitted offline owner.");
      }
      return await run({
        req: { type: "req", id: "templates.add:" + params.agentId, method: "templates.add" },
        params: {},
        client: null,
        context,
        isWebchatConnect: () => false,
        respond: () => {},
        signal: params.signal,
        sessionMutationCommitGuard: params.assertCurrent,
      });
    });
  const runVisibleTurn = async (message: string, sessionKey: string, phase: string) => {
    params.assertCurrent();
    const result = await agentCommandFromSystem(
      {
        agentId: params.agentId,
        sessionKey,
        message,
        runId: "templates.add:" + params.agentId + ":" + phase,
        timeout: "120",
        toolsAllow: [],
        deferWorkspaceBootstrap: true,
        suppressPromptPersistence: true,
        deliver: false,
        abortSignal: params.signal,
        assertSourceCurrent: params.assertCurrent,
      },
      withoutRuntimeOutput(params.runtime),
      deps,
    );
    params.assertCurrent();
    const reply = result?.meta.terminalReply;
    if (readAgentRunTerminalOutcome(result) !== "completed" || reply?.disposition !== "visible") {
      throw new Error(
        "Template " +
          phase +
          " did not complete with visible model output. The agent and conversation were kept.",
      );
    }
    params.runtime.log(sanitizeTerminalText(reply.text));
  };
  return {
    prepareAgentSession: async (config) =>
      withSessionOwner(async (options) => {
        const prepared = await completeAgentOnboarding(options, params.agentId, {
          config,
          commandSource: "cli",
        });
        if (prepared.preparationUncertain) {
          throw new TemplateAddMutationError(
            "agent_session_outcome_uncertain",
            prepared.status === "error"
              ? prepared.error
              : "Ordinary session preparation outcome is uncertain",
          );
        }
        if (prepared.status !== "completed" || !prepared.rollback) {
          throw new Error(
            prepared.status === "error"
              ? prepared.error
              : "The agent conversation could not be prepared.",
          );
        }
        return prepared.rollback;
      }),
    waitForAgentRuntime: async () => {
      params.assertCurrent();
      // Offline has no Gateway reload. Join the ordinary local runtime owner
      // without calling a model; config presence alone is not runtime readiness.
      return await runLocalAgentCommand({
        opts: {
          agentId: params.agentId,
          message: TEMPLATE_AGENT_OPENING_MESSAGE,
          toolsAllow: [],
          deferWorkspaceBootstrap: true,
          suppressPromptPersistence: true,
          abortSignal: params.signal,
          assertSourceCurrent: params.assertCurrent,
        },
        runtime: withoutRuntimeOutput(params.runtime),
        deps,
        run: async () => {
          params.assertCurrent();
          return "applied" as const;
        },
      });
    },
    onAgentReady: async ({ sessionKey }) =>
      runVisibleTurn(TEMPLATE_AGENT_OPENING_MESSAGE, sessionKey, "opening"),
    onSetupEvent: async (event) => {
      await withSessionOwner(async (options) =>
        publishTemplateInstallEvent(options.context, event, params.assertCurrent),
      );
      params.assertCurrent();
      params.runtime.log(sanitizeTerminalText(formatTemplateInstallOutcome(event)));
    },
  };
}
