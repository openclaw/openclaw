import { APPROVALS_SCOPE } from "../../gateway/operator-scopes.js";
import { getPluginSessionExtensionSync } from "../host-hook-state.js";
import type {
  OpenClawPluginApi,
  PluginSessionSchedulerJobHandle,
  PluginTrustedToolPolicyRegistration,
} from "../types.js";

const SESSION_KEY = "agent:main:main";
const APPROVAL_PLUGIN_ID = "approval-workflow-fixture";

export function registerApprovalWorkflowFixture(api: OpenClawPluginApi) {
  api.registerSessionExtension({
    namespace: "approval",
    description: "Generic approval workflow state",
  });
  api.registerControlUiDescriptor({
    id: "approval-card",
    surface: "session",
    label: "Approval request",
    description: "Renders a generic approval request for an operator decision.",
    placement: "session-main",
    renderer: "approval-card",
    stateNamespace: "approval",
    actionIds: ["resolve-approval"],
    requiredScopes: [APPROVALS_SCOPE],
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        status: { enum: ["pending", "approved", "denied"] },
      },
    },
  });
  api.registerControlUiDescriptor({
    id: "approval-input-guard",
    surface: "session",
    label: "Input guard",
    description: "Hints that inbound input should wait while an approval is pending.",
    placement: "composer",
    renderer: "input-guard",
    stateNamespace: "approval",
  });
  api.registerControlUiDescriptor({
    id: "workflow-sidebar",
    surface: "session",
    label: "Workflow status",
    description: "Shows generic workflow progress in a side panel.",
    placement: "right-sidebar",
    renderer: "sidebar-panel",
    stateNamespace: "approval",
  });
  api.registerSessionAction({
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
      api.emitAgentEvent({
        runId: "approval-workflow-run",
        stream: "approval",
        ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
        data: {
          phase: "resolved",
          decision,
        },
      });
      await api.enqueueNextTurnInjection({
        sessionKey: ctx.sessionKey ?? SESSION_KEY,
        placement: "prepend_context",
        priority: 100,
        idempotencyKey: `approval:${decision}`,
        text: `Operator decision received: ${decision}. Continue the workflow.`,
      });
      return {
        data: { decision },
        reply: { text: `Approval ${decision}` },
        continueAgent: true,
      };
    },
  });
  api.on("inbound_claim", (event, ctx) => {
    const approval = getPluginSessionExtensionSync<{ status?: string }>({
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
  api.registerSessionExtension({
    namespace: "policy",
    description: "Generic workspace policy state",
  });
  api.registerTrustedToolPolicy({
    id: "workspace-policy",
    description: "Blocks mutating tools while the workspace policy is locked.",
    evaluate(event, ctx) {
      const state = ctx.getSessionExtension?.<{ locked?: boolean; reason?: string }>("policy");
      if (state?.locked && event.toolName === "mutating_tool") {
        return {
          block: true,
          blockReason: state.reason ?? "blocked by workspace policy",
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
  api.registerSessionExtension({
    namespace: "monitor",
    description: "Generic background monitor state",
  });
  api.registerAgentEventSubscription({
    id: "monitor-events",
    description: "Records status events for background workflows.",
    streams: ["tool", "error"],
    handle(event, ctx) {
      ctx.setRunContext("last-status", {
        stream: event.stream,
        runId: event.runId,
      });
    },
  });
  api.registerRuntimeLifecycle({
    id: "monitor-cleanup",
    description: "Cleans plugin-owned monitor state.",
  });
  scheduled.push(
    api.scheduleSessionTurn({
      sessionKey: SESSION_KEY,
      delayMs: 60_000,
      message: "Background monitor wake-up",
      payload: { reason: "status-check" },
      name: "background-monitor-status-check",
    }),
  );
  api.on("heartbeat_prompt_contribution", () => ({
    appendContext: "Background monitor status: waiting for the next check.",
  }));
}

export function registerArtifactReplyFixture(api: OpenClawPluginApi, artifactPath: string) {
  api.registerSessionAction({
    id: "send-artifact",
    description: "Send a generated artifact to the active session channel.",
    async handler(ctx) {
      const result = await api.sendSessionAttachment({
        sessionKey: ctx.sessionKey ?? SESSION_KEY,
        files: [{ path: artifactPath, name: "workflow-artifact.txt", mime: "text/plain" }],
        text: "Generated workflow artifact",
      });
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      return {
        data: {
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
