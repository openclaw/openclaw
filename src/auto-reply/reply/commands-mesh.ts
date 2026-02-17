import { callGateway } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import type { CommandHandler } from "./commands-types.js";

type MeshPlanShape = {
  planId: string;
  goal: string;
  createdAt: number;
  steps: Array<{ id: string; name?: string; prompt: string; dependsOn?: string[] }>;
};
type CachedMeshPlan = { plan: MeshPlanShape; createdAt: number };

type ParsedMeshCommand =
  | { ok: true; action: "help" }
  | { ok: true; action: "run" | "plan"; target: string }
  | { ok: true; action: "status"; runId: string }
  | { ok: true; action: "retry"; runId: string; stepIds?: string[] }
  | { ok: false; message: string }
  | null;

const meshPlanCache = new Map<string, CachedMeshPlan>();
const MAX_CACHED_MESH_PLANS = 200;

function trimMeshPlanCache() {
  if (meshPlanCache.size <= MAX_CACHED_MESH_PLANS) {
    return;
  }
  const oldest = [...meshPlanCache.entries()]
    .toSorted((a, b) => a[1].createdAt - b[1].createdAt)
    .slice(0, meshPlanCache.size - MAX_CACHED_MESH_PLANS);
  for (const [key] of oldest) {
    meshPlanCache.delete(key);
  }
}

function parseMeshCommand(commandBody: string): ParsedMeshCommand {
  const trimmed = commandBody.trim();
  if (!/^\/mesh\b/i.test(trimmed)) {
    return null;
  }
  const rest = trimmed.replace(/^\/mesh\b:?/i, "").trim();
  if (!rest || /^help$/i.test(rest)) {
    return { ok: true, action: "help" };
  }

  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { ok: true, action: "help" };
  }

  const actionCandidate = tokens[0]?.toLowerCase() ?? "";
  const explicitAction =
    actionCandidate === "run" ||
    actionCandidate === "plan" ||
    actionCandidate === "status" ||
    actionCandidate === "retry"
      ? actionCandidate
      : null;

  if (!explicitAction) {
    // Shorthand: `/mesh <goal>` => auto plan + run
    return { ok: true, action: "run", target: rest };
  }

  const actionArgs = rest.slice(tokens[0]?.length ?? 0).trim();
  if (explicitAction === "plan" || explicitAction === "run") {
    if (!actionArgs) {
      return { ok: false, message: `Usage: /mesh ${explicitAction} <goal>` };
    }
    return { ok: true, action: explicitAction, target: actionArgs };
  }

  if (explicitAction === "status") {
    if (!actionArgs) {
      return { ok: false, message: "Usage: /mesh status <runId>" };
    }
    return { ok: true, action: "status", runId: actionArgs.split(/\s+/)[0] };
  }

  // retry
  const argsTokens = actionArgs.split(/\s+/).filter(Boolean);
  if (argsTokens.length === 0) {
    return { ok: false, message: "Usage: /mesh retry <runId> [step1,step2,...]" };
  }
  const runId = argsTokens[0];
  const stepArg = argsTokens.slice(1).join(" ").trim();
  const stepIds =
    stepArg.length > 0
      ? stepArg
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : undefined;
  return { ok: true, action: "retry", runId, stepIds };
}

function cacheKeyForPlan(params: Parameters<CommandHandler>[0], planId: string) {
  const sender = params.command.senderId ?? "unknown";
  const channel = params.command.channel || "unknown";
  return `${channel}:${sender}:${planId}`;
}

function putCachedPlan(params: Parameters<CommandHandler>[0], plan: MeshPlanShape) {
  meshPlanCache.set(cacheKeyForPlan(params, plan.planId), { plan, createdAt: Date.now() });
  trimMeshPlanCache();
}

function getCachedPlan(
  params: Parameters<CommandHandler>[0],
  planId: string,
): MeshPlanShape | null {
  return meshPlanCache.get(cacheKeyForPlan(params, planId))?.plan ?? null;
}

function looksLikeMeshPlanId(value: string) {
  return /^mesh-plan-[a-z0-9-]+$/i.test(value.trim());
}

function resolveMeshCommandBody(params: Parameters<CommandHandler>[0]) {
  return (
    params.ctx.BodyForCommands ??
    params.ctx.CommandBody ??
    params.ctx.RawBody ??
    params.ctx.Body ??
    params.command.commandBodyNormalized
  );
}

function formatPlanSummary(plan: {
  goal: string;
  steps: Array<{ id: string; name?: string; prompt: string; dependsOn?: string[] }>;
}) {
  const lines = [`🕸️ Mesh Plan`, `Goal: ${plan.goal}`, "", `Steps (${plan.steps.length}):`];
  for (const step of plan.steps) {
    const dependsOn = Array.isArray(step.dependsOn) && step.dependsOn.length > 0;
    const depLine = dependsOn ? ` (depends on: ${step.dependsOn?.join(", ")})` : "";
    lines.push(`- ${step.id}${step.name ? ` — ${step.name}` : ""}${depLine}`);
    lines.push(`  ${step.prompt}`);
  }
  return lines.join("\n");
}

function formatRunSummary(payload: {
  runId: string;
  status: string;
  stats?: {
    total?: number;
    succeeded?: number;
    failed?: number;
    skipped?: number;
    running?: number;
    pending?: number;
  };
}) {
  const stats = payload.stats ?? {};
  return [
    `🕸️ Mesh Run`,
    `Run: ${payload.runId}`,
    `Status: ${payload.status}`,
    `Steps: total=${stats.total ?? 0}, ok=${stats.succeeded ?? 0}, failed=${stats.failed ?? 0}, skipped=${stats.skipped ?? 0}, running=${stats.running ?? 0}, pending=${stats.pending ?? 0}`,
  ].join("\n");
}

function meshUsageText() {
  return [
    "🕸️ Mesh command",
    "Usage:",
    "- /mesh <goal>  (auto plan + run)",
    "- /mesh plan <goal>",
    "- /mesh run <goal|mesh-plan-id>",
    "- /mesh status <runId>",
    "- /mesh retry <runId> [step1,step2,...]",
  ].join("\n");
}

function resolveMeshClientLabel(params: Parameters<CommandHandler>[0]) {
  const channel = params.command.channel;
  const sender = params.command.senderId ?? "unknown";
  return `Chat mesh (${channel}:${sender})`;
}

export const handleMeshCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseMeshCommand(resolveMeshCommandBody(params));
  if (!parsed) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /mesh from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  if (!parsed.ok) {
    return { shouldContinue: false, reply: { text: parsed.message } };
  }
  if (parsed.action === "help") {
    return { shouldContinue: false, reply: { text: meshUsageText() } };
  }

  const clientDisplayName = resolveMeshClientLabel(params);
  const commonGateway = {
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName,
    mode: GATEWAY_CLIENT_MODES.BACKEND,
  } as const;

  try {
    if (parsed.action === "plan") {
      const planResp = await callGateway<{
        plan: MeshPlanShape;
        order?: string[];
        source?: string;
      }>({
        method: "mesh.plan.auto",
        params: {
          goal: parsed.target,
          agentId: params.agentId ?? "main",
        },
        ...commonGateway,
      });
      putCachedPlan(params, planResp.plan);
      const sourceLine = planResp.source ? `\nPlanner source: ${planResp.source}` : "";
      return {
        shouldContinue: false,
        reply: {
          text: `${formatPlanSummary(planResp.plan)}${sourceLine}\n\nRun exact plan: /mesh run ${planResp.plan.planId}`,
        },
      };
    }

    if (parsed.action === "run") {
      let runPlan: MeshPlanShape;
      if (looksLikeMeshPlanId(parsed.target)) {
        const cached = getCachedPlan(params, parsed.target.trim());
        if (!cached) {
          return {
            shouldContinue: false,
            reply: {
              text: `Plan ${parsed.target.trim()} not found in this chat.\nCreate one first: /mesh plan <goal>`,
            },
          };
        }
        runPlan = cached;
      } else {
        const planResp = await callGateway<{
          plan: MeshPlanShape;
          order?: string[];
          source?: string;
        }>({
          method: "mesh.plan.auto",
          params: {
            goal: parsed.target,
            agentId: params.agentId ?? "main",
          },
          ...commonGateway,
        });
        putCachedPlan(params, planResp.plan);
        runPlan = planResp.plan;
      }

      const runResp = await callGateway<{
        runId: string;
        status: string;
        stats?: {
          total?: number;
          succeeded?: number;
          failed?: number;
          skipped?: number;
          running?: number;
          pending?: number;
        };
      }>({
        method: "mesh.run",
        params: {
          plan: runPlan,
        },
        ...commonGateway,
      });

      return {
        shouldContinue: false,
        reply: {
          text: `${formatPlanSummary(runPlan)}\n\n${formatRunSummary(runResp)}`,
        },
      };
    }

    if (parsed.action === "status") {
      const statusResp = await callGateway<{
        runId: string;
        status: string;
        stats?: {
          total?: number;
          succeeded?: number;
          failed?: number;
          skipped?: number;
          running?: number;
          pending?: number;
        };
      }>({
        method: "mesh.status",
        params: { runId: parsed.runId },
        ...commonGateway,
      });
      return {
        shouldContinue: false,
        reply: { text: formatRunSummary(statusResp) },
      };
    }

    if (parsed.action === "retry") {
      const retryResp = await callGateway<{
        runId: string;
        status: string;
        stats?: {
          total?: number;
          succeeded?: number;
          failed?: number;
          skipped?: number;
          running?: number;
          pending?: number;
        };
      }>({
        method: "mesh.retry",
        params: {
          runId: parsed.runId,
          ...(parsed.stepIds && parsed.stepIds.length > 0 ? { stepIds: parsed.stepIds } : {}),
        },
        ...commonGateway,
      });
      return {
        shouldContinue: false,
        reply: { text: `🔁 Retry submitted\n${formatRunSummary(retryResp)}` },
      };
    }

    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      shouldContinue: false,
      reply: {
        text: `❌ Mesh command failed: ${message}`,
      },
    };
  }
};
