import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useRPCQuery, useRPC } from "@/hooks";

export function DebugPage() {
  const { data: status } = useRPCQuery<Record<string, unknown>>("status");
  const rpc = useRPC();

  const [rpcMethod, setRpcMethod] = useState("");
  const [rpcParams, setRpcParams] = useState("{}");
  const [rpcResult, setRpcResult] = useState("");

  const sendRPC = async () => {
    try {
      const params = JSON.parse(rpcParams);
      const result = await rpc(rpcMethod, params);
      setRpcResult(JSON.stringify(result, null, 2));
    } catch (e) {
      setRpcResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Debug</h1>

      <Card>
        <CardHeader>
          <CardTitle>System Info</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="text-xs overflow-auto bg-muted p-4 rounded">
            {JSON.stringify(status, null, 2)}
          </pre>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>RPC Tester</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            placeholder="Method (e.g. health)"
            value={rpcMethod}
            onChange={(e) => setRpcMethod(e.target.value)}
          />
          <Textarea
            className="font-mono"
            placeholder='{"key": "value"}'
            value={rpcParams}
            onChange={(e) => setRpcParams(e.target.value)}
          />
          <Button onClick={sendRPC}>Send</Button>
          {rpcResult && (
            <pre className="text-xs overflow-auto bg-muted p-4 rounded max-h-96">
              {rpcResult}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
