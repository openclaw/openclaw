import { randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { startTelegramProofIngress } from "../../scripts/mantis/telegram-proof-ingress.mts";
import type { TelegramProofPlan } from "../../scripts/mantis/telegram-proof-plan.ts";

export const plan: TelegramProofPlan = {
  claim: "A selected reply is observed",
  actions: [{ type: "send", atMs: 0, text: "hello" }],
  modelReplies: ["reply"],
  settings: { streaming: "off", nativeCommands: false },
  maxDurationMs: 1000,
  expectations: ["The bot answers reply"],
};

export async function makeIngress(
  root: string,
  options: Pick<Parameters<typeof startTelegramProofIngress>[0], "lease"> &
    Partial<Parameters<typeof startTelegramProofIngress>[0]>,
) {
  // Keep Unix sockets below Darwin's 104-byte limit.
  const socket =
    process.platform === "win32"
      ? `\\\\.\\pipe\\mantis-${randomUUID()}`
      : path.join(root, "api.sock");
  const ingress = await startTelegramProofIngress({
    socket,
    alias: "1:fixture",
    sutToken: "private-token",
    testerId: "43",
    plan,
    providerLog: path.join(root, "provider.ndjson"),
    ...options,
  });
  const responses: unknown[] = [];
  const request = (method: string, body: unknown, route = `/telegram/bot1:fixture/${method}`) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: socket,
          path: route,
          method: "POST",
          headers: { "content-type": "application/json" },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            responses.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            resolve(response.statusCode!);
          });
        },
      );
      req.on("error", reject);
      req.end(typeof body === "string" ? body : JSON.stringify(body));
    });
  return { ingress, request, responses, close: () => ingress.close() };
}
