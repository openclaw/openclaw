import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useRPCQuery, useRPC } from "@/hooks";
import { useGatewayStore } from "@/stores/gateway";

export function OverviewPage() {
  const status = useGatewayStore((s) => s.status);
  const { data: health, isLoading } = useRPCQuery<{
    ok: boolean;
    agents: number;
    sessions: { count: number; recent: number };
    uptime: number;
  }>("health");

  const { data: devices } = useRPCQuery<{
    devices: { id: string; name: string; status: string }[];
  }>("device.pair.list");

  const rpc = useRPC();
  const [token, setToken] = useState("");

  const handleLogin = () => {
    const gatewayUrl = window.location.origin;
    sessionStorage.setItem(`openclaw-token-${gatewayUrl}`, token);
    window.location.reload();
  };

  const approveDevice = async (id: string) => {
    await rpc("device.pair.approve", { id });
  };

  const rejectDevice = async (id: string) => {
    await rpc("device.pair.reject", { id });
  };

  if (status !== "connected") {
    return (
      <div className="max-w-md mx-auto mt-12 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Connect to Gateway</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input
              type="password"
              placeholder="Gateway token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <Button onClick={handleLogin} className="w-full">
              Connect
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Overview</h1>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      ) : health ? (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Status</CardTitle>
            </CardHeader>
            <CardContent>
              <Badge variant={health.ok ? "default" : "destructive"}>
                {health.ok ? "Healthy" : "Unhealthy"}
              </Badge>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Uptime</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">
                {Math.floor(health.uptime / 3600)}h{" "}
                {Math.floor((health.uptime % 3600) / 60)}m
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Agents</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{health.agents}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Sessions</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{health.sessions.count}</p>
              <p className="text-sm text-muted-foreground">
                {health.sessions.recent} recent
              </p>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {devices && devices.devices.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Device Pairing Requests</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Device</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.devices.map((device) => (
                  <TableRow key={device.id}>
                    <TableCell>
                      {device.name ?? device.id.slice(0, 8)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{device.status}</Badge>
                    </TableCell>
                    <TableCell className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => approveDevice(device.id)}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => rejectDevice(device.id)}
                      >
                        Reject
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
