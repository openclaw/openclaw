import { Badge } from "@/components/ui/badge";
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
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import { useRPCQuery, useRPC } from "@/hooks";

interface ChannelStatus {
  channel: string;
  status: "connected" | "disconnected" | "error" | "unknown";
  details?: Record<string, unknown>;
}

export function ChannelsPage() {
  const { data, isLoading } = useRPCQuery<{ channels: ChannelStatus[] }>(
    "channels.status",
    {
      probe: true,
      timeoutMs: 5000,
    },
  );
  const rpc = useRPC();
  const [qrDialogOpen, setQrDialogOpen] = useState(false);
  const [qrCode, setQrCode] = useState<string | null>(null);

  const statusVariant = (status: string) => {
    switch (status) {
      case "connected":
        return "default" as const;
      case "disconnected":
        return "secondary" as const;
      case "error":
        return "destructive" as const;
      default:
        return "outline" as const;
    }
  };

  const startWhatsAppLogin = async () => {
    const result = await rpc<{ qr: string }>("web.login.start", {});
    setQrCode(result.qr);
    setQrDialogOpen(true);
  };

  const logout = async (channel: string) => {
    await rpc("channels.logout", { channel });
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Channels</h1>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Channel</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.channels.map((ch) => (
              <TableRow key={ch.channel}>
                <TableCell className="capitalize">{ch.channel}</TableCell>
                <TableCell>
                  <Badge variant={statusVariant(ch.status)}>{ch.status}</Badge>
                </TableCell>
                <TableCell className="flex gap-2">
                  {ch.channel === "whatsapp" &&
                    ch.status === "disconnected" && (
                      <Button size="sm" onClick={startWhatsAppLogin}>
                        Connect
                      </Button>
                    )}
                  {ch.status === "connected" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => logout(ch.channel)}
                    >
                      Disconnect
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={qrDialogOpen} onOpenChange={setQrDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>WhatsApp Login</DialogTitle>
          </DialogHeader>
          <div className="flex items-center justify-center p-8">
            {qrCode ? (
              <img
                src={`data:image/png;base64,${qrCode}`}
                alt="WhatsApp QR Code"
                className="w-64 h-64"
              />
            ) : (
              <Skeleton className="w-64 h-64" />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
