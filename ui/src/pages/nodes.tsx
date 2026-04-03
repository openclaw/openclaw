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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useState, useCallback } from "react";
import { useRPCQuery, useRPC, useEvent } from "@/hooks";

interface Node {
  id: string;
  name: string;
  status: "online" | "offline" | "pairing";
}

export function NodesPage() {
  const { data, isLoading, refetch } = useRPCQuery<{ nodes: Node[] }>(
    "node.list",
  );
  const rpc = useRPC();
  const [pairDialog, setPairDialog] = useState(false);
  const [pendingPairs, setPendingPairs] = useState<
    { id: string; name: string }[]
  >([]);

  const handlePairRequested = useCallback((payload: unknown) => {
    const p = payload as { id: string; name: string };
    setPendingPairs((prev) => [...prev, p]);
    setPairDialog(true);
  }, []);

  useEvent("node.pair.requested", handlePairRequested);

  const approveNode = async (id: string) => {
    await rpc("node.pair.approve", { id });
    setPendingPairs((prev) => prev.filter((p) => p.id !== id));
    if (pendingPairs.length <= 1) setPairDialog(false);
    refetch();
  };

  const rejectNode = async (id: string) => {
    await rpc("node.pair.reject", { id });
    setPendingPairs((prev) => prev.filter((p) => p.id !== id));
    if (pendingPairs.length <= 1) setPairDialog(false);
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Nodes</h1>

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
              <TableHead>Name</TableHead>
              <TableHead>ID</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.nodes.map((node) => (
              <TableRow key={node.id}>
                <TableCell>{node.name}</TableCell>
                <TableCell className="font-mono text-sm">
                  {node.id.slice(0, 12)}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      node.status === "online"
                        ? "default"
                        : node.status === "pairing"
                          ? "outline"
                          : "secondary"
                    }
                  >
                    {node.status}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={pairDialog} onOpenChange={setPairDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Node Pairing Request</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            {pendingPairs.map((pair) => (
              <div
                key={pair.id}
                className="flex items-center justify-between p-2 border rounded"
              >
                <span>{pair.name ?? pair.id.slice(0, 12)}</span>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => approveNode(pair.id)}>
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => rejectNode(pair.id)}
                  >
                    Reject
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
