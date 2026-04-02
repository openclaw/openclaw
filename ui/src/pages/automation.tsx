import { useState } from "react";
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
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useRPCQuery, useRPC } from "@/hooks";

interface AutomationRule {
  id: string;
  name: string;
  trigger: string;
  action: string;
  enabled: boolean;
}

export function AutomationPage() {
  const { data, isLoading, refetch } = useRPCQuery<{
    snapshot: Record<string, unknown>;
  }>("config.get");
  const rpc = useRPC();
  const [editDialog, setEditDialog] = useState(false);
  const [editRule, setEditRule] = useState<Partial<AutomationRule>>({});

  const rules =
    ((data?.snapshot?.automation as Record<string, unknown>)
      ?.rules as AutomationRule[]) ?? [];

  const toggleRule = async (id: string, enabled: boolean) => {
    const updated = rules.map((r) => (r.id === id ? { ...r, enabled } : r));
    await rpc("config.patch", { automation: { rules: updated } });
    refetch();
  };

  const saveRule = async () => {
    const updated = editRule.id
      ? rules.map((r) => (r.id === editRule.id ? { ...r, ...editRule } : r))
      : [...rules, { ...editRule, id: crypto.randomUUID(), enabled: true }];
    await rpc("config.patch", { automation: { rules: updated } });
    setEditDialog(false);
    refetch();
  };

  const deleteRule = async (id: string) => {
    const updated = rules.filter((r) => r.id !== id);
    await rpc("config.patch", { automation: { rules: updated } });
    refetch();
  };

  if (isLoading) return <Skeleton className="h-64" />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Automation</h1>
        <Button
          onClick={() => {
            setEditRule({});
            setEditDialog(true);
          }}
        >
          Add Rule
        </Button>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Trigger</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Enabled</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rules.map((rule) => (
            <TableRow key={rule.id}>
              <TableCell>{rule.name}</TableCell>
              <TableCell>{rule.trigger}</TableCell>
              <TableCell>{rule.action}</TableCell>
              <TableCell>
                <Switch
                  checked={rule.enabled}
                  onCheckedChange={(v) => toggleRule(rule.id, v)}
                />
              </TableCell>
              <TableCell className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditRule(rule);
                    setEditDialog(true);
                  }}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => deleteRule(rule.id)}
                >
                  Delete
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog open={editDialog} onOpenChange={setEditDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editRule.id ? "Edit Rule" : "Add Rule"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <Input
              placeholder="Rule name"
              value={editRule.name ?? ""}
              onChange={(e) =>
                setEditRule({ ...editRule, name: e.target.value })
              }
            />
            <Select
              value={editRule.trigger ?? ""}
              onValueChange={(v) =>
                setEditRule({ ...editRule, trigger: v ?? "" })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select trigger" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="message_received">
                  Message Received
                </SelectItem>
                <SelectItem value="session_created">Session Created</SelectItem>
                <SelectItem value="channel_connected">
                  Channel Connected
                </SelectItem>
                <SelectItem value="schedule">Schedule</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={editRule.action ?? ""}
              onValueChange={(v) =>
                setEditRule({ ...editRule, action: v ?? "" })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select action" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="send_message">Send Message</SelectItem>
                <SelectItem value="run_agent">Run Agent</SelectItem>
                <SelectItem value="notify">Notify</SelectItem>
                <SelectItem value="webhook">Webhook</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditDialog(false)}>
                Cancel
              </Button>
              <Button onClick={saveRule}>Save</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
