import { useState, useEffect } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { useRPCQuery, useRPC } from "@/hooks";

export function ConfigPage() {
  const { data, isLoading } = useRPCQuery<{
    raw: string;
    snapshot: Record<string, unknown>;
  }>("config.get");
  const rpc = useRPC();
  const [rawConfig, setRawConfig] = useState("");

  useEffect(() => {
    if (data?.raw) setRawConfig(data.raw);
  }, [data?.raw]);

  const saveConfig = async () => {
    try {
      await rpc("config.set", { raw: rawConfig });
      toast.success("Config saved");
    } catch (e) {
      toast.error(
        `Failed to save: ${e instanceof Error ? e.message : "Unknown error"}`,
      );
    }
  };

  const applyConfig = async () => {
    try {
      await rpc("config.apply", {});
      toast.success("Config applied — gateway may restart");
    } catch (e) {
      toast.error(
        `Failed to apply: ${e instanceof Error ? e.message : "Unknown error"}`,
      );
    }
  };

  if (isLoading) return <Skeleton className="h-96" />;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Config</h1>

      <Tabs defaultValue="raw">
        <TabsList>
          <TabsTrigger value="raw">Raw Editor</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
        </TabsList>

        <TabsContent value="raw" className="mt-4">
          <Card>
            <CardContent className="pt-6 space-y-4">
              <Textarea
                className="font-mono min-h-[500px]"
                value={rawConfig}
                onChange={(e) => setRawConfig(e.target.value)}
              />
              <div className="flex gap-2">
                <Button onClick={saveConfig}>Save</Button>
                <Button variant="outline" onClick={applyConfig}>
                  Save & Apply
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="preview" className="mt-4">
          <Card>
            <CardContent className="pt-6">
              <pre className="text-xs overflow-auto">
                {JSON.stringify(data?.snapshot, null, 2)}
              </pre>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
