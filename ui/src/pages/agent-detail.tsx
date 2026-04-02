import { useState } from "react";
import { useParams, useNavigate } from "@tanstack/react-router";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useRPCQuery, useRPC } from "@/hooks";

export function AgentDetailPage() {
  const { agentId } = useParams({ from: "/agents/$agentId" });
  const navigate = useNavigate();
  const rpc = useRPC();

  const { data: agents } = useRPCQuery<{
    agents: {
      id: string;
      name: string;
      model?: string;
      config?: Record<string, unknown>;
    }[];
  }>("agents.list");
  const agent = agents?.agents.find((a) => a.id === agentId);

  const { data: models } = useRPCQuery<{
    models: { id: string; name: string }[];
  }>("models.list");
  const { data: files } = useRPCQuery<{ files: string[] }>(
    "agents.files.list",
    { agentId },
  );

  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const loadFile = async (filename: string) => {
    setSelectedFile(filename);
    const result = await rpc<{ content: string }>("agents.files.get", {
      agentId,
      filename,
    });
    setFileContent(result.content);
  };

  const saveFile = async () => {
    if (!selectedFile) return;
    await rpc("agents.files.set", {
      agentId,
      filename: selectedFile,
      content: fileContent,
    });
  };

  const saveAgent = async () => {
    await rpc("agents.update", {
      id: agentId,
      name: name || agent?.name,
      model: model || agent?.model,
    });
    navigate({ to: "/agents" });
  };

  if (!agent) {
    return <Skeleton className="h-96" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{agent.name}</h1>
        <Button variant="outline" onClick={() => navigate({ to: "/agents" })}>
          Back
        </Button>
      </div>

      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="model">Model</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Agent Settings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Input
                placeholder="Agent name"
                defaultValue={agent.name}
                onChange={(e) => setName(e.target.value)}
              />
              <Button onClick={saveAgent}>Save</Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="model" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Model Configuration</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Select
                defaultValue={agent.model}
                onValueChange={(v) => setModel(v ?? "")}
              >
                <SelectTrigger>
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
              <Button onClick={saveAgent}>Save</Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="files" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Agent Files</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2 flex-wrap">
                {files?.files.map((f) => (
                  <Button
                    key={f}
                    variant={selectedFile === f ? "default" : "outline"}
                    size="sm"
                    onClick={() => loadFile(f)}
                  >
                    {f}
                  </Button>
                ))}
              </div>
              {selectedFile && (
                <>
                  <Textarea
                    className="font-mono min-h-[300px]"
                    value={fileContent}
                    onChange={(e) => setFileContent(e.target.value)}
                  />
                  <Button onClick={saveFile}>Save File</Button>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
