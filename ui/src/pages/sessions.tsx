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
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useState } from "react";
import { useRPCQuery, useRPC } from "@/hooks";

interface SessionListItem {
  key: string;
  label?: string;
  agentId?: string;
  createdAt?: string;
  lastMessageAt?: string;
  messageCount?: number;
  status?: string;
}

export function SessionsPage() {
  const { data, isLoading, refetch } = useRPCQuery<{
    sessions: SessionListItem[];
  }>("sessions.list", {
    includeGlobal: true,
    includeUnknown: false,
  });
  const rpc = useRPC();
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<unknown>(null);

  const handlePreview = async (key: string) => {
    setPreviewKey(key);
    const result = await rpc("sessions.preview", { key });
    setPreview(result);
  };

  const handleAction = async (
    key: string,
    action: "reset" | "delete" | "compact",
  ) => {
    switch (action) {
      case "reset":
        await rpc("sessions.reset", { key });
        break;
      case "delete":
        await rpc("sessions.delete", { key, deleteTranscript: false });
        break;
      case "compact":
        await rpc("sessions.compact", { key });
        break;
    }
    refetch();
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Sessions</h1>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Session</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>Messages</TableHead>
              <TableHead>Last Active</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.sessions.map((session) => (
              <TableRow key={session.key}>
                <TableCell
                  className="cursor-pointer hover:underline"
                  onClick={() => handlePreview(session.key)}
                >
                  {session.label ?? session.key.slice(0, 12)}
                </TableCell>
                <TableCell>{session.agentId ?? "-"}</TableCell>
                <TableCell>{session.messageCount ?? 0}</TableCell>
                <TableCell>
                  {session.lastMessageAt
                    ? new Date(session.lastMessageAt).toLocaleString()
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
                        onClick={() => handleAction(session.key, "reset")}
                      >
                        Reset
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => handleAction(session.key, "compact")}
                      >
                        Compact
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={() => handleAction(session.key, "delete")}
                      >
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Sheet
        open={previewKey !== null}
        onOpenChange={() => setPreviewKey(null)}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Session Preview</SheetTitle>
          </SheetHeader>
          <ScrollArea className="mt-4 h-[calc(100vh-100px)]">
            <pre className="text-xs whitespace-pre-wrap">
              {JSON.stringify(preview, null, 2)}
            </pre>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </div>
  );
}
