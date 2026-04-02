import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useRPCQuery, useRPC, useEvent } from "@/hooks";
import { useCallback } from "react";

interface Instance {
  key: string;
  agentId?: string;
  status: "running" | "stopped" | "error";
  startedAt?: string;
  uptime?: number;
}

export function InstancesPage() {
  const rpc = useRPC();
  const { data, isLoading, refetch } = useRPCQuery<{ sessions: Instance[] }>(
    "sessions.list",
    {
      includeGlobal: false,
      includeUnknown: false,
      activeMinutes: 60,
    },
  );

  const handleSessionsChanged = useCallback(() => {
    refetch();
  }, [refetch]);

  useEvent("sessions.changed", handleSessionsChanged);

  const statusVariant = (status: string) => {
    switch (status) {
      case "running":
        return "default" as const;
      case "stopped":
        return "secondary" as const;
      case "error":
        return "destructive" as const;
      default:
        return "outline" as const;
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Instances</h1>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Instance ID</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.sessions.map((instance) => (
              <TableRow key={instance.key}>
                <TableCell className="font-mono text-sm">
                  {instance.key.slice(0, 12)}
                </TableCell>
                <TableCell>{instance.agentId ?? "-"}</TableCell>
                <TableCell>
                  <Badge variant={statusVariant(instance.status)}>
                    {instance.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  {instance.startedAt
                    ? new Date(instance.startedAt).toLocaleString()
                    : "-"}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button variant="ghost" size="sm">
                          ...
                        </Button>
                      }
                    />
                    <DropdownMenuContent>
                      <DropdownMenuItem
                        onClick={async () => {
                          await rpc("sessions.abort", { key: instance.key });
                          refetch();
                        }}
                      >
                        Stop
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={async () => {
                          await rpc("sessions.reset", { key: instance.key });
                          refetch();
                        }}
                      >
                        Restart
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
