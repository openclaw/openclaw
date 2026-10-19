type Runtime = { port: number; ownerToken: string };

export function requestMcp(
  runtime: Runtime,
  message: unknown,
  options: {
    token?: string;
    captureKey?: string;
    sessionKey?: string;
    signal?: AbortSignal;
    connection?: string;
    method?: "GET" | "POST";
  } = {},
) {
  return fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
    method: options.method ?? "POST",
    signal: options.signal,
    headers: {
      authorization: `Bearer ${options.token ?? runtime.ownerToken}`,
      "content-type": "application/json",
      ...(options.captureKey ? { "x-openclaw-cli-capture-key": options.captureKey } : {}),
      ...(options.sessionKey ? { "x-session-key": options.sessionKey } : {}),
      ...(options.connection ? { connection: options.connection } : {}),
    },
    ...(message ? { body: JSON.stringify(message) } : {}),
  });
}

export function toolCall(
  name: string,
  args: Record<string, unknown> = {},
  id: string | number = 1,
) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}
