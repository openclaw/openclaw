import { useCallback, useEffect, useState, useRef } from "react";
import { useGateway } from "./use-gateway";
import { onTeamPushEvent } from "./use-gateway";

// ─── Types mirroring gateway team types ──────────────────────────────

export type TeamMember = {
  agentId: string;
  sessionKey: string;
  role?: string;
  state: "idle" | "running" | "done";
  joinedAt: number;
};

export type TeamRun = {
  id: string;
  name: string;
  leader: string;
  leaderSession: string;
  members: TeamMember[];
  state: "active" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
};

export type TeamTask = {
  id: string;
  teamRunId: string;
  subject: string;
  description: string;
  owner?: string;
  status: "pending" | "in_progress" | "completed";
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
};

export type TeamMessage = {
  id: string;
  teamRunId: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
};

// ─── Hook: list team runs with polling + push ─────────────────────────

/** Fallback polling interval — WebSocket push is primary. */
const POLL_INTERVAL_MS = 30_000;

export function useTeamRuns(filter?: {
  leader?: string;
  state?: "active" | "completed" | "failed";
  limit?: number;
}) {
  const { sendRpc } = useGateway();
  const [teamRuns, setTeamRuns] = useState<TeamRun[]>([]);
  const [loading, setLoading] = useState(true);
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const refresh = useCallback(async () => {
    try {
      const result = await sendRpc<TeamRun[]>("teamRuns.list", filterRef.current ?? {});
      setTeamRuns(result);
    } catch (err) {
      console.error("[teams] failed to list team runs:", err);
    } finally {
      setLoading(false);
    }
  }, [sendRpc]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    // Subscribe to real-time team events pushed via WebSocket
    const unsubscribe = onTeamPushEvent(() => {
      void refresh();
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [refresh]);

  return { teamRuns, loading, refresh };
}

// ─── Hook: single team run detail ────────────────────────────────────

export function useTeamRun(teamRunId: string | null) {
  const { sendRpc } = useGateway();
  const [teamRun, setTeamRun] = useState<TeamRun | null>(null);
  const [tasks, setTasks] = useState<TeamTask[]>([]);
  const [messages, setMessages] = useState<TeamMessage[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!teamRunId) {
      setTeamRun(null);
      setTasks([]);
      setMessages([]);
      setLoading(false);
      return;
    }
    try {
      const [run, taskList, msgList] = await Promise.all([
        sendRpc<TeamRun>("teamRuns.get", { id: teamRunId }),
        sendRpc<TeamTask[]>("teamTasks.list", { teamRunId }),
        sendRpc<TeamMessage[]>("teamMessages.list", { teamRunId }),
      ]);
      setTeamRun(run);
      setTasks(taskList);
      setMessages(msgList);
    } catch (err) {
      console.error("[teams] failed to load team run:", err);
    } finally {
      setLoading(false);
    }
  }, [sendRpc, teamRunId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    // Subscribe to real-time team events; only refresh when the event
    // concerns the team run we are currently viewing.
    const unsubscribe = onTeamPushEvent((payload) => {
      const evt = payload as { teamRunId?: string } | undefined;
      if (!teamRunId || !evt?.teamRunId || evt.teamRunId === teamRunId) {
        void refresh();
      }
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [refresh, teamRunId]);

  return { teamRun, tasks, messages, loading, refresh };
}

// ─── Mutation helpers ────────────────────────────────────────────────

export function useTeamMutations() {
  const { sendRpc } = useGateway();

  const createRun = useCallback(
    (name: string, leader: string, leaderSession: string) =>
      sendRpc<TeamRun>("teamRuns.create", { name, leader, leaderSession }),
    [sendRpc],
  );

  const completeRun = useCallback(
    (id: string, state: "completed" | "failed") =>
      sendRpc<TeamRun>("teamRuns.complete", { id, state }),
    [sendRpc],
  );

  const addMember = useCallback(
    (teamRunId: string, agentId: string, sessionKey: string, role?: string) =>
      sendRpc<TeamMember>("teamRuns.addMember", { teamRunId, agentId, sessionKey, role }),
    [sendRpc],
  );

  const createTask = useCallback(
    (teamRunId: string, subject: string, description: string) =>
      sendRpc<TeamTask>("teamTasks.create", { teamRunId, subject, description }),
    [sendRpc],
  );

  const updateTask = useCallback(
    (
      teamRunId: string,
      taskId: string,
      patch: Partial<Pick<TeamTask, "owner" | "status" | "subject" | "description" | "blockedBy">>,
    ) => sendRpc<TeamTask>("teamTasks.update", { teamRunId, taskId, ...patch }),
    [sendRpc],
  );

  const sendMessage = useCallback(
    (teamRunId: string, from: string, to: string, content: string) =>
      sendRpc<TeamMessage>("teamMessages.send", { teamRunId, from, to, content }),
    [sendRpc],
  );

  return { createRun, completeRun, addMember, createTask, updateTask, sendMessage };
}
