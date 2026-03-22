import WebSocket from "ws";

type RealtimeEvent =
  | { type: "session.created" | "session.updated" }
  | { type: "response.output_text.delta"; delta?: string }
  | { type: "response.text.delta"; delta?: string }
  | { type: "response.done" }
  | { type: "error"; error?: { message?: string } };

export function buildAzureRealtimeWebSocketUrl(baseUrl: string, model: string): string {
  const wsBase = baseUrl
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:")
    .replace(/\/+$/, "");
  return `${wsBase}/realtime?model=${encodeURIComponent(model)}`;
}

function rawDataToUtf8(raw: WebSocket.RawData): string | null {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
  }
  return null;
}

export class AzureRealtimeTextClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async runTextTurn(params: { instructions: string; inputText: string }): Promise<string> {
    const url = buildAzureRealtimeWebSocketUrl(this.baseUrl, this.model);

    return await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: {
          "api-key": this.apiKey,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      let buffer = "";
      let settled = false;
      const timeout = setTimeout(() => {
        fail(new Error(`Azure realtime timed out for model ${this.model}`));
      }, 20_000);

      const cleanup = () => {
        clearTimeout(timeout);
        socket.removeAllListeners();
        try {
          socket.close();
        } catch {
          // Ignore close errors.
        }
      };

      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      const succeed = (text: string) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(text.trim());
      };

      socket.on("message", (raw) => {
        let event: RealtimeEvent;
        const payload = rawDataToUtf8(raw);
        if (!payload) {
          return;
        }
        try {
          event = JSON.parse(payload) as RealtimeEvent;
        } catch {
          return;
        }

        if (event.type === "session.created") {
          socket.send(
            JSON.stringify({
              type: "session.update",
              session: {
                type: "realtime",
                instructions: params.instructions,
                output_modalities: ["text"],
              },
            }),
          );
          socket.send(
            JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: params.inputText }],
              },
            }),
          );
          socket.send(JSON.stringify({ type: "response.create" }));
          return;
        }

        if (
          (event.type === "response.output_text.delta" || event.type === "response.text.delta") &&
          typeof event.delta === "string"
        ) {
          buffer += event.delta;
          return;
        }

        if (event.type === "response.done") {
          succeed(buffer);
          return;
        }

        if (event.type === "error") {
          fail(new Error(event.error?.message || "Azure realtime request failed"));
        }
      });

      socket.on("error", (error) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });

      socket.on("close", (code, reason) => {
        if (!settled) {
          fail(new Error(`Azure realtime socket closed (${code} ${String(reason)})`));
        }
      });
    });
  }
}
