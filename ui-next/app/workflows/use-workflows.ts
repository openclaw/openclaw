import { Node, Edge } from "@xyflow/react";
import { useState, useEffect } from "react";
import type { CronJobCreate } from "@/lib/types";
import { useGateway } from "@/lib/use-gateway";

export interface WorkflowItem {
  id: string;
  name: string;
  nodes: Node[];
  edges: Edge[];
  updatedAt: string;
  cronJobIds?: string[];
  triggerConfigs?: WorkflowTriggerConfig[];
}

// ============================================
// Workflow Trigger Configuration
// ============================================
export interface WorkflowTriggerConfig {
  type: "cron" | "chat";
  triggerNodeId: string;
  enabled: boolean;
  
  // NEW: Session configuration
  sessionConfig?: {
    target: 'isolated' | 'reuse' | 'main';
    contextMode: 'minimal' | 'full' | 'custom';
    model?: string;
    maxTokens?: number;
    thinking?: 'on' | 'off';
  };
  
  // Cron-specific
  cronExpr?: string;
  // Chat-specific
  sessionKey?: string;
  matchKeyword?: string;
}

// ============================================
// Workflow Chain Step — encode vào description của Cron Job.
// Backend (server-cron.ts) parse để chạy sequential.
// ============================================
export interface WorkflowChainStep {
  nodeId: string;
  actionType: string;
  label: string;

  // Agent Prompt
  agentId?: string;
  prompt?: string; // Hỗ trợ {{input}} — backend replace bằng output bước trước
  outputSchema?: Record<string, unknown>; // ✅ NEW: JSON Schema for structured output

  // Send Message
  body?: string;
  channel?: string;
  recipientId?: string;
  accountId?: string;

  // If/Else Branching
  condition?: string;
  trueChain?: WorkflowChainStep[];
  falseChain?: WorkflowChainStep[];

  // Execute Tool
  toolName?: string;
  toolArgs?: Record<string, unknown>;

  // Remote Invoke
  targetNodeId?: string;
  command?: string;
  params?: Record<string, unknown>;

  // TTS (Speak)
  ttsText?: string;
  voiceId?: string;
  ttsProvider?: string;

  // Delay
  durationMs?: number;

  // Custom JS
  jsCode?: string;

  // Supabase fields
  supabaseInstance?: string;
  table?: string;
  columns?: string;
  filters?: Record<string, unknown>;
  limit?: number;
  orderBy?: string;
  row?: Record<string, unknown>;
  updates?: Record<string, unknown>;
  function?: string;
  paramsData?: Record<string, unknown>;

  // NEW: Session Configuration (passed from trigger)
  sessionConfig?: {
    target: 'isolated' | 'reuse' | 'main';
    contextMode: 'minimal' | 'full' | 'custom';
    model?: string;
    maxTokens?: number;
    thinking?: 'on' | 'off';
  };
}

const WF_CHAIN_PREFIX = "__wf_chain__:";

/**
 * BFS từ triggerId, trả về danh sách action nodes theo thứ tự kết nối.
 * Hỗ trợ branching cho logic nodes (If/Else).
 */
function extractChainFromTrigger(
  triggerId: string,
  nodes: Node[],
  edges: Edge[],
): WorkflowChainStep[] {
  const chain: WorkflowChainStep[] = [];
  const visited = new Set<string>();

  // Extract session config from trigger node data
  const triggerNode = nodes.find((n) => n.id === triggerId);
  const sessionConfig = (triggerNode?.data as any)?.sessionConfig ? {
    target: ((triggerNode?.data as any).sessionConfig.target as 'isolated' | 'reuse' | 'main') || 'isolated',
    contextMode: ((triggerNode?.data as any).sessionConfig.contextMode as 'minimal' | 'full' | 'custom') || 'minimal',
    model: (triggerNode?.data as any).sessionConfig.model as string | undefined,
    maxTokens: (triggerNode?.data as any).sessionConfig.maxTokens as number | undefined,
    thinking: ((triggerNode?.data as any).sessionConfig.thinking as 'on' | 'off') || 'off',
  } : undefined;

  // Find all edges from trigger
  const outgoingEdges = edges.filter((e) => e.source === triggerId);

  for (const edge of outgoingEdges) {
    const step = extractNodeChain(edge.target, nodes, edges, visited, sessionConfig);
    if (step) {
      chain.push(step);
    }
  }

  return chain;
}

/**
 * Recursively extract chain from a node, handling branches
 */
function extractNodeChain(
  nodeId: string,
  nodes: Node[],
  edges: Edge[],
  visited: Set<string>,
  sessionConfig?: WorkflowChainStep['sessionConfig'],
): WorkflowChainStep | null {
  if (visited.has(nodeId)) {
    return null;
  }
  visited.add(nodeId);

  const node = nodes.find((n) => n.id === nodeId);
  if (!node) {
    return null;
  }

  const label = (node.data?.label as string) || "";
  const rawActionType = node.data?.actionType as string | undefined;

  // Determine action type
  let actionType =
    rawActionType ||
    (label === "AI Agent Prompt" ? "agent-prompt" : "") ||
    (label === "Send Message" ? "send-message" : "") ||
    (label === "If / Else" ? "if-else" : "") ||
    "unknown";

  // Build step config
  const step: WorkflowChainStep = {
    nodeId,
    actionType,
    label,
    agentId: (node.data?.agentId as string) || undefined,
    prompt: (node.data?.prompt as string) || undefined,
    outputSchema: (node.data?.outputSchema as string) ? JSON.parse(node.data.outputSchema as string) : undefined,
    body: (node.data?.body as string) || undefined,
    channel: (node.data?.channel as string) || undefined,
    recipientId: (node.data?.recipientId as string) || undefined,
    accountId: (node.data?.accountId as string) || undefined,
    condition: (node.data?.condition as string) || undefined,
    // Supabase fields
    supabaseInstance: (node.data?.supabaseInstance as string) || undefined,
    table: (node.data?.table as string) || undefined,
    columns: (node.data?.columns as string) || undefined,
    filters: (node.data?.filters as string) ? JSON.parse(node.data.filters as string) : undefined,
    limit: (node.data?.limit as number | string) ? Number(node.data.limit) : undefined,
    orderBy: (node.data?.orderBy as string) || undefined,
    row: (node.data?.row as string) ? JSON.parse(node.data.row as string) : undefined,
    updates: (node.data?.updates as string) ? JSON.parse(node.data.updates as string) : undefined,
    function: (node.data?.function as string) || undefined,
    paramsData: (node.data?.paramsStr as string) ? JSON.parse(node.data.paramsStr as string) : undefined,
    // Include session config from trigger (only on first step)
    sessionConfig: sessionConfig,
  };

  // If this is a logic node (If/Else), extract branches separately
  if (actionType === "if-else") {
    // Find all outgoing edges (true and false branches)
    const outgoingEdges = edges.filter((e) => e.source === nodeId);

    console.log("[WORKFLOW DEBUG] Processing If/Else node:", {
      nodeId,
      outgoingEdgesCount: outgoingEdges.length,
      edges: outgoingEdges.map((e) => ({
        target: e.target,
        sourceHandle: e.sourceHandle,
        label: e.data?.label || e.label,
      })),
    });

    // Process each outgoing edge
    for (const edge of outgoingEdges) {
      // Use sourceHandle from React Flow (set by custom-nodes.tsx)
      const sourceHandle = edge.sourceHandle as string | undefined; // "true" or "false"
      const edgeLabel = (edge.data?.label as string) || (edge.label as string) || "";

      // Determine branch type from handle ID or edge label
      const isTrueBranch =
        sourceHandle === "true" ||
        edgeLabel.toLowerCase() === "true" ||
        edgeLabel.toLowerCase() === "yes";
      const isFalseBranch =
        sourceHandle === "false" ||
        edgeLabel.toLowerCase() === "false" ||
        edgeLabel.toLowerCase() === "no";

      console.log("[WORKFLOW DEBUG] Processing edge:", {
        target: edge.target,
        sourceHandle,
        edgeLabel,
        isTrueBranch,
        isFalseBranch,
      });

      const branchStep = extractNodeChain(edge.target, nodes, edges, new Set(visited));

      if (branchStep) {
        if (isTrueBranch) {
          // Explicitly labeled "true" → true branch
          step.trueChain = step.trueChain || [];
          step.trueChain.push(branchStep);
          console.log("[WORKFLOW DEBUG] Added to TRUE branch:", branchStep.nodeId);
        } else if (isFalseBranch) {
          // Explicitly labeled "false" → false branch
          step.falseChain = step.falseChain || [];
          step.falseChain.push(branchStep);
          console.log("[WORKFLOW DEBUG] Added to FALSE branch:", branchStep.nodeId);
        } else {
          // Fallback: first edge goes to trueChain
          if (!step.trueChain) {
            step.trueChain = [];
          }
          step.trueChain.push(branchStep);
          console.log("[WORKFLOW DEBUG] Added to TRUE branch (fallback):", branchStep.nodeId);
        }
      }
    }

    // Log for debugging
    console.log("[WORKFLOW DEBUG] Extracted If/Else node:", {
      nodeId,
      hasTrueBranch: step.trueChain !== undefined && step.trueChain.length > 0,
      hasFalseBranch: step.falseChain !== undefined && step.falseChain.length > 0,
      trueChainLength: step.trueChain?.length || 0,
      falseChainLength: step.falseChain?.length || 0,
    });
  } else {
    // For non-logic nodes, extract sequential next step
    // Find the first outgoing edge (sequential flow)
    const outgoingEdges = edges.filter((e) => e.source === nodeId);

    // For sequential nodes, we expect only ONE outgoing edge
    // If there are multiple, we take the first one (shouldn't happen in valid workflows)
    if (outgoingEdges.length > 0) {
      const nextEdge = outgoingEdges[0];
      const nextStep = extractNodeChain(nextEdge.target, nodes, edges, visited);

      if (nextStep) {
        // Store as single next step in trueChain array (for compatibility)
        step.trueChain = [nextStep];
      }
    }
  }

  return step;
}

export function useWorkflows() {
  const [workflows, setWorkflows] = useState<WorkflowItem[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { request, state } = useGateway();

  useEffect(() => {
    if (state !== "connected") {
      return;
    }

    let active = true;
    void Promise.resolve().then(() => {
      void (active && setLoading(true));
    });
    request<{ workflows: WorkflowItem[] }>("workflows.get", {})
      .then((res) => {
        if (active) {
          setWorkflows(res.workflows || []);
          setLoading(false);
        }
      })
      .catch((e) => {
        console.error("Failed to load workflows", e);
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [request, state]);

  const saveWorkflow = async (id: string, name: string, nodes: Node[], edges: Edge[]) => {
    console.log("[WORKFLOW DEBUG] saveWorkflow called:", {
      id,
      name,
      nodesCount: nodes.length,
      edgesCount: edges.length,
    });

    // ============================================
    // Validate workflow structure
    // ============================================
    const validationErrors: string[] = [];

    // Check If/Else nodes have exactly 2 outgoing edges with labels
    const ifElseNodes = nodes.filter((n) => n.data?.label === "If / Else");
    for (const node of ifElseNodes) {
      const outgoingEdges = edges.filter((e) => e.source === node.id);
      const nodeLabel = typeof node.data?.label === "string" ? node.data.label : node.id;

      if (outgoingEdges.length !== 2) {
        validationErrors.push(
          `If/Else node "${nodeLabel}" must have exactly 2 outgoing edges (has ${outgoingEdges.length})`,
        );
      } else {
        // Check edge labels - can be in edge.data.label, edge.label, or inferred from sourceHandle
        const labelSet = new Set<string>();
        for (const edge of outgoingEdges) {
          const dataLabel = (edge.data?.label as string) || (edge.label as string) || "";
          const sourceHandle = edge.sourceHandle as string | undefined;

          // Use sourceHandle if available (from If/Else custom handles)
          if (sourceHandle === "true" || sourceHandle === "false") {
            labelSet.add(sourceHandle);
          } else if (dataLabel) {
            // Otherwise use edge label
            labelSet.add(dataLabel.toLowerCase());
          }
        }

        const hasTrue = labelSet.has("true") || labelSet.has("yes");
        const hasFalse = labelSet.has("false") || labelSet.has("no");

        if (!hasTrue || !hasFalse) {
          validationErrors.push(
            `If/Else node "${nodeLabel}" edges must be labeled "true" and "false"`,
          );
        }
      }
    }

    // Check for cycles
    function hasCycle(startNodeId: string, visited: Set<string>, path: Set<string>): boolean {
      if (path.has(startNodeId)) {
        return true;
      }
      if (visited.has(startNodeId)) {
        return false;
      }

      visited.add(startNodeId);
      path.add(startNodeId);

      const outgoingEdges = edges.filter((e) => e.source === startNodeId);
      for (const edge of outgoingEdges) {
        if (hasCycle(edge.target, visited, path)) {
          return true;
        }
      }

      path.delete(startNodeId);
      return false;
    }

    const triggerNodes = nodes.filter((n) => n.type === "trigger");
    for (const trigger of triggerNodes) {
      if (hasCycle(trigger.id, new Set(), new Set())) {
        validationErrors.push("Workflow contains cycles - please remove loops");
        break;
      }
    }

    if (validationErrors.length > 0) {
      alert("Workflow validation failed:\n\n" + validationErrors.join("\n"));
      throw new Error("Workflow validation failed: " + validationErrors.join(", "));
    }

    console.log("[WORKFLOW DEBUG] Validation passed");

    // 1. Xoá các cron jobs cũ của workflow này
    const existingWorkflow = workflows.find((w) => w.id === id);
    if (existingWorkflow?.cronJobIds) {
      console.log("[WORKFLOW DEBUG] Removing old cron jobs:", existingWorkflow.cronJobIds);
      for (const cronId of existingWorkflow.cronJobIds) {
        try {
          await request("cron.remove", { jobId: cronId });
          console.log("[WORKFLOW DEBUG] Removed cron job:", cronId);
        } catch (e) {
          console.error("[WORKFLOW DEBUG] Failed to remove old cron job", cronId, e);
        }
      }
    }

    const newCronJobIds: string[] = [];
    const triggerConfigs: WorkflowTriggerConfig[] = [];

    // 2. Process all triggers (Cron + Chat)
    const allTriggers = nodes.filter((n) => n.type === "trigger");

    console.log("[WORKFLOW DEBUG] Found all triggers:", allTriggers.length);

    for (const trigger of allTriggers) {
      const triggerLabel = trigger.data?.label as string;
      const isCronTrigger = triggerLabel === "Schedule (Cron)";
      const isChatTrigger = triggerLabel === "Chat Message";

      if (!isCronTrigger && !isChatTrigger) {
        console.log("[WORKFLOW DEBUG] Skipping unknown trigger type:", triggerLabel);
        continue;
      }

      // BFS lấy toàn bộ chuỗi action nodes từ trigger này
      const chain = extractChainFromTrigger(trigger.id, nodes, edges);
      console.log("[WORKFLOW DEBUG] Extracted chain from trigger:", {
        triggerId: trigger.id,
        triggerLabel,
        chainLength: chain.length,
        steps: chain.map((s) => ({ nodeId: s.nodeId, actionType: s.actionType, label: s.label })),
      });

      if (chain.length === 0) {
        console.log("[WORKFLOW DEBUG] Chain is empty for trigger:", trigger.id);
        // Still register the trigger config even if chain is empty (user might add nodes later)
      }

      const firstStep = chain[0];

      // Encode chain vào description (chỉ khi có nhiều hơn 1 bước)
      // Backend sẽ parse __wf_chain__:<json> để chạy sequential
      const description =
        chain.length > 0
          ? `${WF_CHAIN_PREFIX}${JSON.stringify(chain, null, 2)}`
          : `Generated from Workflow Editor (trigger: ${trigger.id})`;

      console.log("[WORKFLOW DEBUG] Chain description:", description.substring(0, 1000));
      console.log("[WORKFLOW DEBUG] Full chain structure:", JSON.stringify(chain, null, 2));

      // agentId từ bước đầu tiên (nếu là agent-prompt)
      const agentId =
        firstStep?.actionType === "agent-prompt" ? firstStep.agentId || undefined : undefined;

      if (isCronTrigger) {
        // === CRON TRIGGER ===
        const cronExpr = (trigger.data.cronExpr as string) || "*/5 * * * *";
        
        // Extract session config from trigger node
        const sessionConfig = trigger.data?.sessionConfig as {
          target?: 'isolated' | 'reuse' | 'main';
          contextMode?: 'minimal' | 'full' | 'custom';
          model?: string;
          maxTokens?: number;
          thinking?: 'on' | 'off';
        } | undefined;

        console.log("[WORKFLOW DEBUG] Processing CRON trigger:", {
          triggerId: trigger.id,
          cronExpr,
          sessionConfig,
        });

        if (chain.length === 0) {
          continue; // Skip cron jobs without actions
        }

        // Payload cho cron job (dựa theo bước đầu tiên)
        let jobCreate: CronJobCreate;

        if (firstStep.actionType === "agent-prompt" || chain.length > 1) {
          const firstPrompt = firstStep.prompt || firstStep.body || "Ping from Workflow";
          jobCreate = {
            name: `Workflow: ${name}`,
            description,
            enabled: true,
            agentId,
            schedule: { kind: "cron", expr: cronExpr },
            sessionTarget: sessionConfig?.target || "isolated",
            wakeMode: "now",
            payload: { kind: "agentTurn", message: firstPrompt },
          };
        } else {
          // Chain đơn, bước duy nhất là send-message
          jobCreate = {
            name: `Workflow: ${name}`,
            description,
            enabled: true,
            schedule: { kind: "cron", expr: cronExpr },
            sessionTarget: sessionConfig?.target || "isolated",
            wakeMode: "now",
            payload: { kind: "systemEvent", text: firstStep.body || "Hello from workflow!" },
            delivery: { mode: "announce" },
          };
        }

        console.log("[WORKFLOW DEBUG] Creating cron job:", {
          name: jobCreate.name,
          schedule: jobCreate.schedule,
          payload: jobCreate.payload,
          descriptionPreview: jobCreate.description?.substring(0, 200),
        });

        try {
          const res = await request<{ id: string }>("cron.add", jobCreate);
          console.log("[WORKFLOW DEBUG] Cron job created:", res.id);
          newCronJobIds.push(res.id);

          // Add to trigger configs
          triggerConfigs.push({
            type: "cron",
            triggerNodeId: trigger.id,
            enabled: true,
            cronExpr,
            sessionConfig: sessionConfig ? {
              target: sessionConfig.target || 'isolated',
              contextMode: ((trigger.data as any)?.contextMode as 'minimal' | 'full' | 'custom') || 'minimal',
              model: sessionConfig.model,
              maxTokens: sessionConfig.maxTokens,
              thinking: sessionConfig.thinking || 'off',
            } : undefined,
          });
        } catch (e) {
          console.error("[WORKFLOW DEBUG] Failed to add cron job for workflow chain", e);
          throw e;
        }
      } else if (isChatTrigger) {
        // === CHAT MESSAGE TRIGGER ===
        const sessionKey = trigger.data?.targetSessionKey as string | undefined;
        const matchKeyword = trigger.data?.matchKeyword as string | undefined;
        
        // Extract session config from trigger node
        const sessionConfig = trigger.data?.sessionConfig as {
          target?: 'isolated' | 'reuse' | 'main';
          contextMode?: 'minimal' | 'full' | 'custom';
          model?: string;
          maxTokens?: number;
          thinking?: 'on' | 'off';
        } | undefined;

        console.log("[WORKFLOW DEBUG] Processing CHAT trigger:", {
          triggerId: trigger.id,
          sessionKey,
          matchKeyword,
          sessionConfig,
        });

        if (!sessionKey) {
          console.warn("[WORKFLOW DEBUG] Chat trigger missing sessionKey, skipping");
          continue;
        }

        // For chat triggers, we still create a cron job for execution
        // but it will be triggered by events, not schedule
        const jobCreate: CronJobCreate = {
          name: `Workflow: ${name} (Chat Trigger)`,
          description,
          enabled: true,
          agentId,
          schedule: { kind: "event", type: "chat-message" }, // Event-based schedule
          sessionTarget: sessionConfig?.target || "isolated",
          wakeMode: "now",
          payload: {
            kind: "agentTurn",
            message: firstStep?.prompt || firstStep?.body || "Chat message received",
          },
        };

        try {
          const res = await request<{ id: string }>("cron.add", jobCreate);
          console.log("[WORKFLOW DEBUG] Chat trigger cron job created:", res.id);
          newCronJobIds.push(res.id);

          // Add to trigger configs
          triggerConfigs.push({
            type: "chat",
            triggerNodeId: trigger.id,
            enabled: true,
            sessionKey,
            matchKeyword,
            sessionConfig: sessionConfig ? {
              target: sessionConfig.target || 'isolated',
              contextMode: ((trigger.data as any)?.contextMode as 'minimal' | 'full' | 'custom') || 'minimal',
              model: sessionConfig.model,
              maxTokens: sessionConfig.maxTokens,
              thinking: sessionConfig.thinking || 'off',
            } : undefined,
          });
        } catch (e) {
          console.error("[WORKFLOW DEBUG] Failed to add chat trigger cron job", e);
          throw e;
        }
      }
    }

    console.log("[WORKFLOW DEBUG] New cron job IDs:", newCronJobIds);
    console.log("[WORKFLOW DEBUG] Trigger configs:", triggerConfigs);

    setWorkflows((prev) => {
      const existing = prev.find((w) => w.id === id);
      const updatedList = existing
        ? prev.map((w) =>
            w.id === id
              ? {
                  ...w,
                  name,
                  nodes,
                  edges,
                  updatedAt: new Date().toISOString(),
                  cronJobIds: newCronJobIds,
                  triggerConfigs,
                }
              : w,
          )
        : [
            ...prev,
            {
              id,
              name,
              nodes,
              edges,
              updatedAt: new Date().toISOString(),
              cronJobIds: newCronJobIds,
              triggerConfigs,
            },
          ];

      request("workflows.save", { workflows: updatedList }).catch((e) =>
        console.error("Failed to save workflows", e),
      );
      return updatedList;
    });
  };

  const deleteWorkflow = async (id: string) => {
    const existingWorkflow = workflows.find((w) => w.id === id);
    if (existingWorkflow?.cronJobIds) {
      for (const cronId of existingWorkflow.cronJobIds) {
        try {
          await request("cron.remove", { jobId: cronId });
        } catch (e) {
          console.error("Failed to remove cron job on workflow delete", e);
        }
      }
    }

    setWorkflows((prev) => {
      const updatedList = prev.filter((w) => w.id !== id);
      request("workflows.save", { workflows: updatedList }).catch((e) =>
        console.error("Failed to save workflows", e),
      );
      return updatedList;
    });
    if (currentId === id) {
      setCurrentId(null);
    }
  };

  return { workflows, currentId, setCurrentId, saveWorkflow, deleteWorkflow, loading };
}
