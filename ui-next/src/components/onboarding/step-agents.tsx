import { Users, Loader2 } from "lucide-react";
import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { useGateway } from "@/hooks/use-gateway";
import { getAgentTierInfo, type TierInfo } from "@/lib/matrix-tier-map";

type Props = { onValidChange: (valid: boolean) => void };

type AgentSummary = {
  agentId: string;
  name?: string;
  model?: string;
  department?: string;
};

export function StepAgents({ onValidChange }: Props) {
  const { sendRpc } = useGateway();
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const result = await sendRpc<{ agents: AgentSummary[] }>("agents.list", {});
        setAgents(result.agents ?? []);
      } catch {
        // No agents yet
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [sendRpc]);

  // Always valid -- agents are pre-configured
  useEffect(() => {
    onValidChange(true);
  }, [onValidChange]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Group agents by department using tier info
  const grouped = agents.reduce<Record<string, { tier: TierInfo | null; agents: AgentSummary[] }>>(
    (acc, agent) => {
      const tier = getAgentTierInfo(agent.agentId);
      const key = tier?.department ?? "Other";
      if (!acc[key]) {
        acc[key] = { tier, agents: [] };
      }
      acc[key].agents.push(agent);
      return acc;
    },
    {},
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Agent Team</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Your agent organization is pre-configured. Review the team below.
        </p>
      </div>

      {agents.length === 0 ? (
        <div className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground">
          <Users className="h-8 w-8 mx-auto mb-2 text-muted-foreground/50" />
          No agents configured yet. Agents will be available after setup.
        </div>
      ) : (
        <div className="space-y-4">
          {Object.entries(grouped).map(([dept, { tier, agents: deptAgents }]) => (
            <div key={dept} className="rounded-lg border border-border p-4">
              <div className="flex items-center gap-2 mb-3">
                <h3 className="text-sm font-semibold">{dept}</h3>
                {tier && (
                  <Badge variant="outline" className="text-xs">
                    Tier {tier.tier}
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground ml-auto">
                  {deptAgents.length} agent{deptAgents.length !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {deptAgents.map((agent) => (
                  <div key={agent.agentId} className="rounded-md bg-secondary/30 px-3 py-2 text-sm">
                    <div className="font-medium truncate">{agent.name ?? agent.agentId}</div>
                    {agent.model && (
                      <div className="text-xs text-muted-foreground truncate">{agent.model}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
