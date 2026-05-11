import { APPROVALS_SCOPE, WRITE_SCOPE } from "../../gateway/operator-scopes.js";
import { getPluginSessionExtensionSync } from "../host-hook-state.js";
import type {
  OpenClawPluginApi,
  PluginSessionSchedulerJobHandle,
  PluginTrustedToolPolicyRegistration,
} from "../types.js";

const SESSION_KEY = "agent:main:main";
const APPROVAL_PLUGIN_ID = "approval-workflow-fixture";

export function registerApprovalWorkflowFixture(api: OpenClawPluginApi) {
  api.session.state.registerSessionExtension({
    namespace: "approval",
    description: "Generic approval workflow state",
  });
  api.session.controls.registerControlUiDescriptor({
    id: "approval-card",
    surface: "session",
    label: "Approval request",
    description: "Renders a generic approval request for an operator decision.",
    placement: "session-main",
    requiredScopes: [APPROVALS_SCOPE],
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        status: { enum: ["pending", "approved", "denied"] },
      },
    },
  });
  api.session.controls.registerControlUiDescriptor({
    id: "approval-input-guard",
    surface: "session",
    label: "Input guard",
    description: "Hints that inbound input should wait while an approval is pending.",
    placement: "composer",
    requiredScopes: [APPROVALS_SCOPE],
    schema: {
      type: "object",
      properties: {
        status: { enum: ["pending", "approved", "denied"] },
      },
    },
  });
  api.session.controls.registerControlUiDescriptor({
    id: "workflow-sidebar",
    surface: "session",
    label: "Workflow status",
    description: "Shows generic workflow progress in a side panel.",
    placement: "right-sidebar",
    requiredScopes: [APPROVALS_SCOPE],
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        status: { enum: ["pending", "approved", "denied"] },
      },
    },
  });
  api.session.controls.registerSessionAction({
    id: "resolve-approval",
    description: "Resolve a generic approval workflow and resume the agent.",
    requiredScopes: [APPROVALS_SCOPE],
    schema: {
      type: "object",
      properties: {
        decision: { enum: ["approved", "denied"] },
      },
      required: ["decision"],
    },
    async handler(ctx) {
      let decision = "approved";
      if (ctx.payload && typeof ctx.payload === "object" && !Array.isArray(ctx.payload)) {
        const payloadDecision = (ctx.payload as { decision?: unknown }).decision;
        if (payloadDecision === "approved" || payloadDecision === "denied") {
          decision = payloadDecision;
        }
      }
      api.agent.events.emitAgentEvent({
        runId: "approval-workflow-run",
        stream: "plugin.approval",
        ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
        data: {
          phase: "resolved",
          decision,
        },
      });
      await api.session.workflow.enqueueNextTurnInjection({
        sessionKey: ctx.sessionKey ?? SESSION_KEY,
        placement: "prepend_context",
        idempotencyKey: `approval:${decision}`,
        text: `Operator decision received: ${decision}. Continue the workflow.`,
      });
      return {
        result: { decision },
        reply: { text: `Approval ${decision}` },
        continueAgent: true,
      };
    },
  });
  api.on("inbound_claim", (event, ctx) => {
    const approval = getPluginSessionExtensionSync<{ status?: string }>({
      cfg: api.config,
      pluginId: APPROVAL_PLUGIN_ID,
      sessionKey: ctx.sessionKey ?? event.sessionKey,
      namespace: "approval",
    });
    if (approval?.status !== "pending") {
      return undefined;
    }
    return {
      handled: true,
      reply: { text: "An approval is pending. Use the approval card to continue." },
    };
  });
}

export function registerPolicyGateFixture(api: OpenClawPluginApi, calls: string[] = []) {
  api.session.state.registerSessionExtension({
    namespace: "policy",
    description: "Generic workspace policy state",
  });
  api.registerTrustedToolPolicy({
    id: "workspace-policy",
    description: "Blocks mutating tools while the workspace policy is locked.",
    evaluate(event, ctx) {
      const rawState = ctx.getSessionExtension?.("policy");
      const state =
        rawState && typeof rawState === "object" && !Array.isArray(rawState)
          ? (rawState as { locked?: unknown; reason?: unknown })
          : undefined;
      if (state?.locked === true && event.toolName === "mutating_tool") {
        return {
          block: true,
          blockReason:
            typeof state.reason === "string" ? state.reason : "blocked by workspace policy",
        };
      }
      return undefined;
    },
  } satisfies PluginTrustedToolPolicyRegistration);
  api.on("before_tool_call", () => {
    calls.push("normal-before-tool-call");
    return undefined;
  });
}

export function registerBackgroundMonitorFixture(
  api: OpenClawPluginApi,
  scheduled: Promise<PluginSessionSchedulerJobHandle | undefined>[] = [],
) {
  api.session.state.registerSessionExtension({
    namespace: "monitor",
    description: "Generic background monitor state",
  });
  api.agent.events.registerAgentEventSubscription({
    id: "monitor-events",
    description: "Records status events for background workflows.",
    streams: ["tool", "error"],
    handle(event) {
      api.runContext.setRunContext({
        runId: event.runId,
        namespace: "last-status",
        value: {
          stream: event.stream,
          runId: event.runId,
        },
      });
    },
  });
  api.lifecycle.registerRuntimeLifecycle({
    id: "monitor-cleanup",
    description: "Cleans plugin-owned monitor state.",
  });
  api.session.controls.registerSessionAction({
    id: "schedule-monitor-check",
    description: "Schedule a plugin-owned background monitor wake-up.",
    requiredScopes: [WRITE_SCOPE],
    async handler(ctx) {
      const scheduledTurn = api.session.workflow.scheduleSessionTurn({
        sessionKey: ctx.sessionKey ?? SESSION_KEY,
        delayMs: 60_000,
        message: "Background monitor wake-up",
        name: "background-monitor-status-check",
        tag: "monitor",
      });
      scheduled.push(scheduledTurn);
      const handle = await scheduledTurn;
      return { result: handle ?? null };
    },
  });
  api.on("heartbeat_prompt_contribution", () => ({
    appendContext: "Background monitor status: waiting for the next check.",
  }));
}

export function registerArtifactReplyFixture(api: OpenClawPluginApi, artifactPath: string) {
  api.session.controls.registerSessionAction({
    id: "send-artifact",
    description: "Send a generated artifact to the active session channel.",
    requiredScopes: [WRITE_SCOPE],
    async handler(ctx) {
      const result = await api.session.workflow.sendSessionAttachment({
        sessionKey: ctx.sessionKey ?? SESSION_KEY,
        files: [{ path: artifactPath }],
        text: "Generated workflow artifact",
      });
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      return {
        result: {
          deliveredTo: result.deliveredTo,
          count: result.count,
        },
        reply: { text: "Artifact sent." },
      };
    },
  });
}

export function registerRetryControlFixture(api: OpenClawPluginApi) {
  api.on("before_agent_finalize", () => ({
    action: "revise",
    retry: {
      instruction: "Run one focused follow-up pass before finalizing.",
      idempotencyKey: "retry-control-fixture",
      maxAttempts: 1,
    },
  }));
}
