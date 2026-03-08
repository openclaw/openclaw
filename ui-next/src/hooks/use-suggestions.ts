import { useState, useEffect, useRef } from "react";
import { useGateway } from "./use-gateway";
import type { AgentListResult, AgentFilesListResult } from "@/types/agents";
import type { SessionEntry } from "@/store/chat-store";

// ─── Types ───

export type Suggestion = {
  icon: "history" | "agent" | "skill" | "memory" | "generic";
  label: string;
  description: string;
  action: string;
};

type SkillsListResult = {
  skills: Array<{
    name: string;
    description?: string;
    installed?: boolean;
    version?: string;
    command?: string;
  }>;
};

type SessionsListResult = {
  sessions: SessionEntry[];
};

// ─── Cache ───

type CachedSuggestions = { suggestions: Suggestion[]; ts: number };
const CACHE_TTL_MS = 60_000;
let cachedResult: CachedSuggestions | null = null;

// ─── Generic fallbacks ───

const GENERIC_SUGGESTIONS: Suggestion[] = [
  {
    icon: "generic",
    label: "Summary",
    description: "Summarize a recent conversation",
    action: "Summarize this recent conversation",
  },
  {
    icon: "generic",
    label: "Code",
    description: "Write or review code",
    action: "Write a React component for a dashboard",
  },
  {
    icon: "generic",
    label: "Research",
    description: "Look up information",
    action: "Find the latest trends in AI agents",
  },
];

// ─── Hook ───

const MAX_SUGGESTIONS = 5;

export function useSuggestions() {
  const { sendRpc } = useGateway();
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    // Return cached if still fresh
    if (cachedResult && Date.now() - cachedResult.ts < CACHE_TTL_MS) {
      setSuggestions(cachedResult.suggestions);
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchSuggestions() {
      const items: Suggestion[] = [];

      // Fire all RPCs in parallel, catch individually so one failure doesn't block others
      const [sessionsResult, agentsResult, skillsResult] = await Promise.all([
        sendRpc<SessionsListResult>("sessions.list", {
          limit: 3,
          includeDerivedTitles: true,
        }).catch(() => null),
        sendRpc<AgentListResult>("agents.list").catch(() => null),
        sendRpc<SkillsListResult>("skills.list", {}).catch(() => null),
      ]);

      if (cancelled) return;

      // 1. Recent sessions (priority 1)
      if (sessionsResult?.sessions?.length) {
        const recent = sessionsResult.sessions
          .filter((s) => s.derivedTitle || s.label)
          .slice(0, 2);
        for (const session of recent) {
          const title = session.derivedTitle || session.label || session.key;
          // Truncate long titles
          const shortTitle = title.length > 40 ? title.slice(0, 37) + "..." : title;
          items.push({
            icon: "history",
            label: `Resume: ${shortTitle}`,
            description: "Continue recent conversation",
            action: `Continue the conversation about: ${title}`,
          });
        }
      }

      // 2. Sub-agents (priority 2)
      if (agentsResult?.agents?.length) {
        const subAgents = agentsResult.agents.filter(
          (a) => a.id !== agentsResult.defaultId && a.name,
        );
        for (const agent of subAgents.slice(0, 2)) {
          const name = agent.name || agent.id;
          items.push({
            icon: "agent",
            label: `Check on ${name}`,
            description: agent.role || "View agent status",
            action: `What is ${name}'s current status?`,
          });
        }
      }

      // 3. Available skills (priority 3)
      if (skillsResult?.skills?.length) {
        const installed = skillsResult.skills.filter(
          (s) => s.installed !== false && s.command,
        );
        for (const skill of installed.slice(0, 2)) {
          const cmd = skill.command ?? skill.name;
          items.push({
            icon: "skill",
            label: `Use ${skill.name}`,
            description: skill.description || `Run /${cmd}`,
            action: `/${cmd} `,
          });
        }
      }

      // 4. Memory suggestion (priority 4) — check if default agent has memory files
      if (agentsResult?.defaultId) {
        try {
          const filesResult = await sendRpc<AgentFilesListResult>("agents.files.list", {
            agentId: agentsResult.defaultId,
          });
          if (cancelled) return;
          const fileCount = filesResult?.files?.filter((f) => !f.missing)?.length ?? 0;
          if (fileCount > 0) {
            items.push({
              icon: "memory",
              label: "Review memory",
              description: `${fileCount} memory file${fileCount > 1 ? "s" : ""} available`,
              action: "Review today's memory and recent context",
            });
          }
        } catch {
          // ignore — memory files may not be available
        }
      }

      if (cancelled) return;

      // Trim to max then fill with generics if needed
      const result = items.slice(0, MAX_SUGGESTIONS);
      if (result.length < MAX_SUGGESTIONS) {
        for (const g of GENERIC_SUGGESTIONS) {
          if (result.length >= MAX_SUGGESTIONS) break;
          // Avoid duplicate labels
          if (!result.some((r) => r.label === g.label)) {
            result.push(g);
          }
        }
      }

      cachedResult = { suggestions: result, ts: Date.now() };
      setSuggestions(result);
      setLoading(false);
    }

    fetchSuggestions().catch(() => {
      if (!cancelled) {
        // On total failure, show generic suggestions
        setSuggestions(GENERIC_SUGGESTIONS);
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [sendRpc]);

  return { suggestions, loading };
}
