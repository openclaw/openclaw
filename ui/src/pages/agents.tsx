import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "@tanstack/react-router";
import { useRPCQuery, useRPC } from "@/hooks";

interface Agent {
  id: string;
  name: string;
  model?: string;
  status?: string;
}

export function AgentsPage() {
  const { data, isLoading, refetch } = useRPCQuery<{
    agents: Agent[];
    defaultId: string;
  }>("agents.list");
  const rpc = useRPC();

  const createAgent = async () => {
    await rpc("agents.create", { name: "New Agent" });
    refetch();
  };

  const deleteAgent = async (id: string) => {
    await rpc("agents.delete", { id });
    refetch();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Agents</h1>
        <Button onClick={createAgent}>Create Agent</Button>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {data?.agents.map((agent) => (
            <Card key={agent.id}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">{agent.name}</CardTitle>
                  {agent.id === data.defaultId && (
                    <Badge variant="secondary">Default</Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  {agent.model ?? "No model set"}
                </p>
                <div className="flex gap-2">
                  <Button
                    render={
                      <Link
                        to="/agents/$agentId"
                        params={{ agentId: agent.id }}
                      />
                    }
                    size="sm"
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => deleteAgent(agent.id)}
                  >
                    Delete
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
