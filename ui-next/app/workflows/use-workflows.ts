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
}

// ============================================
// Workflow Chain Step — encode vào description của Cron Job.
// Backend (server-cron.ts) parse để chạy sequential.
// ============================================
export interface WorkflowChainStep {
  nodeId: string;
  actionType: string; // "agent-prompt" | "send-message" | "unknown"
  label: string;
  agentId?: string;
  prompt?: string; // Hỗ trợ {{input}} — backend replace bằng output bước trước
  body?: string; // Dùng cho "send-message"
}

const WF_CHAIN_PREFIX = "__wf_chain__:";

/**
 * BFS từ triggerId, trả về danh sách action nodes theo thứ tự kết nối.
 * Logic nodes được traverse qua (để tiếp tục tìm action phía sau) nhưng
 * không thêm vào chain (chưa có runtime support).
 */
function extractChainFromTrigger(
  triggerId: string,
  nodes: Node[],
  edges: Edge[],
): WorkflowChainStep[] {
  const chain: WorkflowChainStep[] = [];
  const visited = new Set<string>();
  const queue: string[] = [];

  // Seed BFS từ các edge xuất phát từ trigger
  for (const e of edges) {
    if (e.source === triggerId) {
      queue.push(e.target);
    }
  }

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) {
      continue;
    }
    visited.add(nodeId);

    const node = nodes.find((n) => n.id === nodeId);
    if (!node) {
      continue;
    }

    if (node.type === "action") {
      const label = (node.data?.label as string) || "";
      const rawActionType = node.data?.actionType as string | undefined;
      const actionType =
        rawActionType ||
        (label === "AI Agent Prompt" ? "agent-prompt" : "") ||
        (label === "Send Message" ? "send-message" : "") ||
        "unknown";

      chain.push({
        nodeId,
        actionType,
        label,
        agentId: (node.data?.agentId as string) || undefined,
        prompt: (node.data?.prompt as string) || undefined,
        body: (node.data?.body as string) || undefined,
      });
    }

    // Tiếp tục BFS qua node tiếp theo (kể cả logic node)
    for (const e of edges) {
      if (e.source === nodeId && !visited.has(e.target)) {
        queue.push(e.target);
      }
    }
  }

  return chain;
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

    // 2. Với mỗi Schedule (Cron) trigger, BFS toàn bộ chain
    const cronTriggers = nodes.filter(
      (n) => n.type === "trigger" && n.data?.label === "Schedule (Cron)",
    );

    console.log("[WORKFLOW DEBUG] Found cron triggers:", cronTriggers.length);

    for (const trigger of cronTriggers) {
      const cronExpr = (trigger.data.cronExpr as string) || "*/5 * * * *"; // Default: every 5 minutes

      console.log("[WORKFLOW DEBUG] Processing trigger:", {
        triggerId: trigger.id,
        cronExpr,
        triggerData: trigger.data,
      });

      // BFS lấy toàn bộ chuỗi action nodes từ trigger này
      const chain = extractChainFromTrigger(trigger.id, nodes, edges);
      console.log("[WORKFLOW DEBUG] Extracted chain:", {
        chainLength: chain.length,
        steps: chain.map((s) => ({ nodeId: s.nodeId, actionType: s.actionType, label: s.label })),
      });

      if (chain.length === 0) {
        console.log("[WORKFLOW DEBUG] Chain is empty, skipping");
        continue;
      }

      const firstStep = chain[0];

      // Encode chain vào description (chỉ khi có nhiều hơn 1 bước)
      // Backend sẽ parse __wf_chain__:<json> để chạy sequential
      const description =
        chain.length > 1
          ? `${WF_CHAIN_PREFIX}${JSON.stringify(chain)}`
          : `Generated from Workflow Editor (trigger: ${trigger.id})`;

      console.log("[WORKFLOW DEBUG] Chain description:", description.substring(0, 500));

      // agentId từ bước đầu tiên (nếu là agent-prompt)
      const agentId =
        firstStep.actionType === "agent-prompt" ? firstStep.agentId || undefined : undefined;

      // Payload cho cron job (dựa theo bước đầu tiên)
      // Nếu có chain > 1, luôn dùng agentTurn để bước 1 có outputText truyền sang bước tiếp theo
      let jobCreate: CronJobCreate;

      if (firstStep.actionType === "agent-prompt" || chain.length > 1) {
        const firstPrompt = firstStep.prompt || firstStep.body || "Ping from Workflow";
        jobCreate = {
          name: `Workflow: ${name}`,
          description,
          enabled: true,
          agentId,
          schedule: { kind: "cron", expr: cronExpr },
          sessionTarget: "isolated",
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
          sessionTarget: "isolated",
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
      } catch (e) {
        console.error("[WORKFLOW DEBUG] Failed to add cron job for workflow chain", e);
        throw e; // Re-throw to let caller know save failed
      }
    }

    console.log("[WORKFLOW DEBUG] New cron job IDs:", newCronJobIds);

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
