import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import { toast } from "sonner";
import { useRPCQuery, useRPC } from "@/hooks";

export function AIAgentsPage() {
  const { isLoading } = useRPCQuery<{
    snapshot: Record<string, unknown>;
  }>("config.get");
  const { data: models } = useRPCQuery<{
    models: { id: string; name: string }[];
  }>("models.list");
  const rpc = useRPC();
  const [defaultModel, setDefaultModel] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("");

  const save = async () => {
    try {
      await rpc("config.patch", {
        agents: { defaultModel, defaultThinkingLevel: thinkingLevel },
      });
      toast.success("AI agent defaults saved");
    } catch (e) {
      toast.error(
        `Failed: ${e instanceof Error ? e.message : "Unknown error"}`,
      );
    }
  };

  if (isLoading) return <Skeleton className="h-64" />;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">AI Agents</h1>
      <Card>
        <CardHeader>
          <CardTitle>Default Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">Default Model</label>
            <Select
              value={defaultModel}
              onValueChange={(v) => setDefaultModel(v ?? "")}
            >
              <SelectTrigger className="w-64">
                <SelectValue placeholder="Select model" />
              </SelectTrigger>
              <SelectContent>
                {models?.models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">
              Default Thinking Level
            </label>
            <Select
              value={thinkingLevel}
              onValueChange={(v) => setThinkingLevel(v ?? "")}
            >
              <SelectTrigger className="w-64">
                <SelectValue placeholder="Select level" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button onClick={save}>Save</Button>
        </CardContent>
      </Card>
    </div>
  );
}
