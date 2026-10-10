import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBodyWithLimit } from "../infra/http-body.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { DEBUG_PROXY_CHILD_CAPTURE_PATH } from "./child-transport.js";
import { debugProxyCaptureWriteCommandSchema } from "./cli-contract.js";
import { DEBUG_PROXY_CHILD_CAPTURE_USERNAME } from "./env.js";
import type { AsyncDebugProxyCaptureWriter } from "./store.types.js";

export function createDebugProxyChildCaptureReceiver(
  sessionId: string,
  store: Pick<
    AsyncDebugProxyCaptureWriter,
    "upsertSession" | "endSession" | "recordEvent" | "recordEventWithPayload"
  >,
) {
  const token = randomBytes(32).toString("base64url");
  registerSecretValueForRedaction(token);
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  let accepting = true;
  const respond = (res: ServerResponse, code: number) => {
    res.writeHead(code, { connection: "close" });
    res.end();
  };
  const receive = async (req: IncomingMessage, res: ServerResponse) => {
    const authorization = Buffer.from(req.headers.authorization ?? "");
    if (
      !accepting ||
      req.method !== "POST" ||
      authorization.length !== expectedAuthorization.length ||
      !timingSafeEqual(authorization, expectedAuthorization)
    ) {
      req.resume();
      respond(res, 403);
      return;
    }
    const body = await readJsonBodyWithLimit(req, {
      maxBytes: 32 * 1024 * 1024,
      emptyObjectOnEmpty: false,
    });
    const parsed = body.ok ? debugProxyCaptureWriteCommandSchema.safeParse(body.value) : undefined;
    if (!parsed?.success) {
      respond(res, 400);
      return;
    }
    const command = parsed.data;
    const target =
      command.type === "capture.upsertSession"
        ? command.input.id
        : command.type === "capture.recordEventWithPayload"
          ? command.input.event.sessionId
          : command.input.sessionId;
    // The ephemeral parent-session capability is checked again after body preparation.
    if (!accepting || target !== sessionId || req.aborted) {
      respond(res, 403);
      return;
    }
    try {
      switch (command.type) {
        case "capture.upsertSession":
          await store.upsertSession(command.input);
          break;
        case "capture.endSession":
          await store.endSession(command.input.sessionId, command.input.endedAt);
          break;
        case "capture.recordEvent":
          await store.recordEvent(command.input);
          break;
        case "capture.recordEventWithPayload":
          await store.recordEventWithPayload(command.input.event, command.input.payload);
          break;
      }
      respond(res, 204);
    } catch (error) {
      respond(res, 500);
      throw error;
    }
  };
  return {
    captureEnv: (proxyUrl: string) => {
      const endpoint = new URL(proxyUrl);
      endpoint.username = DEBUG_PROXY_CHILD_CAPTURE_USERNAME;
      endpoint.password = token;
      return { OPENCLAW_DEBUG_PROXY_URL: endpoint.toString() };
    },
    stop: () => {
      accepting = false;
    },
    handle: (req: IncomingMessage, res: ServerResponse) =>
      req.url === DEBUG_PROXY_CHILD_CAPTURE_PATH ? receive(req, res) : undefined,
  };
}
