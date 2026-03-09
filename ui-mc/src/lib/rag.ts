// RAG removed - using OpenClaw gateway instead
// Stub exports to prevent compile errors in any existing imports

export type KnowledgeSource = "memory" | "activity" | "task" | "custom" | "document";

export interface KnowledgeItem {
  content: string;
  source: KnowledgeSource;
  source_id?: string;
  metadata?: Record<string, unknown>;
  agent_id?: string;
}

export async function ingestKnowledge(
  _items: KnowledgeItem[],
): Promise<{ success: boolean; count?: number; error?: string }> {
  return { success: true, count: 0 };
}

export async function syncAllKnowledge(
  _memories: Array<{
    id: string;
    content: string;
    category: string;
    tags: string[];
    agentId: string;
  }>,
  _tasks: Array<{
    id: string;
    title: string;
    description: string;
    status: string;
    assignedAgent: string;
    project?: string;
  }>,
  _activities: Array<{ id: string; agentId: string; agentName: string; action: string }>,
): Promise<{ success: boolean; total?: number; error?: string }> {
  return { success: true, total: 0 };
}

export async function streamRagChat({
  onDone,
}: {
  messages: { role: "user" | "assistant"; content: string }[];
  agentId?: string;
  agentName?: string;
  agentRole?: string;
  onDelta: (chunk: string) => void;
  onDone: () => void;
  onError: (error: string) => void;
}): Promise<void> {
  onDone();
}
