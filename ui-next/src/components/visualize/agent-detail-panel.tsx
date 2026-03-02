"use client";

import { ExternalLink, Loader2, User, Cpu, Clock, Layers } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { useAgents } from "@/hooks/use-agents";
import { cn } from "@/lib/utils";
import type { AgentIdentityResult } from "@/types/agents";

export interface AgentDetailPanelProps {
  agentId: string | null;
  onClose: () => void;
}

function formatTimeAgo(ms?: number): string {
  if (!ms) {
    return "n/a";
  }
  const diff = Date.now() - ms;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTokens(tokens?: number): string {
  if (tokens == null) {
    return "n/a";
  }
  if (tokens < 1000) {
    return `${tokens}`;
  }
  if (tokens < 1_000_000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

type AgentDetail = AgentIdentityResult & {
  status?: "active" | "idle";
  model?: string;
  tokensUsed?: number;
  lastActiveMs?: number;
  department?: string;
  zone?: string;
  role?: string;
};

export function AgentDetailPanel({ agentId, onClose }: AgentDetailPanelProps) {
  const { getAgentIdentity } = useAgents();
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!agentId) {
      setAgent(null);
      return;
    }
    setLoading(true);
    getAgentIdentity(agentId)
      .then((result) => {
        setAgent({
          ...result,
          // These fields will be populated when the visualize store is available
          status: "active",
          lastActiveMs: Date.now(),
        });
      })
      .catch(() => {
        setAgent(null);
      })
      .finally(() => setLoading(false));
  }, [agentId, getAgentIdentity]);

  return (
    <Sheet
      open={agentId !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <SheetContent className="flex flex-col">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {agent?.emoji && <span className="text-xl">{agent.emoji}</span>}
            <span className="font-mono">{agent?.name ?? agentId ?? "Agent"}</span>
          </SheetTitle>
          <SheetDescription>{agent?.role ?? "Agent details"}</SheetDescription>
        </SheetHeader>

        <div className="px-4 pb-4 overflow-auto flex-1 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : agent ? (
            <>
              {/* Status */}
              <DetailRow icon={User} label="Status">
                <Badge
                  variant={agent.status === "active" ? "default" : "secondary"}
                  className={cn("text-xs", agent.status === "active" && "bg-green-600 text-white")}
                >
                  {agent.status ?? "unknown"}
                </Badge>
              </DetailRow>

              {/* Model */}
              {agent.model && (
                <DetailRow icon={Cpu} label="Model">
                  <span className="font-mono text-sm">{agent.model}</span>
                </DetailRow>
              )}

              {/* Tokens */}
              <DetailRow icon={Layers} label="Tokens Used">
                <span className="font-mono text-sm tabular-nums">
                  {formatTokens(agent.tokensUsed)}
                </span>
              </DetailRow>

              {/* Last Active */}
              <DetailRow icon={Clock} label="Last Active">
                <span className="text-sm text-muted-foreground tabular-nums">
                  {formatTimeAgo(agent.lastActiveMs)}
                </span>
              </DetailRow>

              {/* Zone / Department */}
              {(agent.zone ?? agent.department) && (
                <DetailRow icon={Layers} label="Zone">
                  <Badge variant="outline" className="text-xs font-mono">
                    {agent.zone ?? agent.department}
                  </Badge>
                </DetailRow>
              )}

              {/* View Details link */}
              <div className="pt-4 border-t">
                <Button variant="outline" size="sm" className="w-full" asChild>
                  <a href="/agents">
                    <ExternalLink className="h-3.5 w-3.5" />
                    View Details
                  </a>
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground py-4">No agent data available.</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DetailRow({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4" />
        <span className="text-sm">{label}</span>
      </div>
      <div>{children}</div>
    </div>
  );
}
