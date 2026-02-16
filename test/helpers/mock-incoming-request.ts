import type { IncomingMessage } from "node:http";
import { EventEmitter } from "node:events";

export function createMockIncomingRequest(chunks: string[]): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & { destroyed?: boolean; destroy: () => void };
  req.destroyed = false;
  req.headers = {};
  req.destroy = () => {
    req.destroyed = true;
  };

  void Promise.resolve().then(() => {
    for (const chunk of chunks) {
      req.emit("data", Buffer.from(chunk, "utf-8"));
      if (req.destroyed) {
        return;
      }
    }
    req.emit("end");
  });

  return req;
}
