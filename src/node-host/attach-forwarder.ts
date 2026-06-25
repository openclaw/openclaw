// Node-side conduit forwarder (PR5). The local harness (Claude Code — TCP-only, see PR3) connects to
// this loopback-TCP MCP endpoint; each JSON-RPC request is relayed over the node's EXISTING gateway
// link via `node.attachRelay` into the gateway's scoped loopback tools. So a harness on a node machine
// reaches the same tool surface as the gateway host WITHOUT the machine opening a direct gateway
// connection and WITHOUT a new gateway endpoint. The grant token rides the harness's Authorization
// header (the node never sees it at rest) and is forwarded per request; scope is bound to the grant.
import http from "node:http";

/** Minimal request/response client surface (GatewayClient.request) so this stays unit-testable. */
type RelayClient = {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
};

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

export type NodeAttachForwarder = {
  port: number;
  url: string;
  close: () => Promise<void>;
};

/** Start the loopback forwarder. Binds an ephemeral 127.0.0.1 port; caller points the harness at `url`. */
export function startNodeAttachForwarder(params: {
  client: RelayClient;
}): Promise<NodeAttachForwarder> {
  const { client } = params;
  const server = http.createServer((req, res) => {
    // Streamable-HTTP MCP: requests are POSTed. The optional GET notification stream carries no
    // server-initiated events here; 405 is the spec-compliant "no server stream", and the harness
    // falls back to plain request/response.
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const grantToken = readBearer(req.headers.authorization);
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        return;
      }
      let mcpMessage: unknown;
      try {
        mcpMessage = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        writeJson(res, 400, rpcError(null, -32700, "Parse error"));
        return;
      }
      void (async () => {
        try {
          const { mcpResponse } = await client.request<{ mcpResponse: unknown }>(
            "node.attachRelay",
            {
              grantToken,
              mcpMessage,
            },
          );
          // A notification (no response) relays back as null — emit 202 with no body, like the loopback.
          if (mcpResponse === null || mcpResponse === undefined) {
            res.writeHead(202).end();
            return;
          }
          writeJson(res, 200, mcpResponse);
        } catch {
          writeJson(res, 502, rpcError(idOf(mcpMessage), -32001, "attach relay failed"));
        }
      })();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        url: `http://127.0.0.1:${port}/mcp`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function readBearer(header: string | undefined): string {
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS).end(JSON.stringify(body));
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function idOf(message: unknown): unknown {
  return message && typeof message === "object" ? (message as { id?: unknown }).id : null;
}
