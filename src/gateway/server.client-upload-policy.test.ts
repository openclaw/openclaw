import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { getMediaDir } from "../media/store.js";
import { handleGatewayRequest } from "./server-methods.js";
import { agentHandlers } from "./server-methods/agent.js";
import { handleChatAbortRequest } from "./server-methods/chat-abort-handler.js";
import { handleDirectExternalChatSend } from "./server-methods/chat-send-external-entry.js";
import { sessionCreateHandlers } from "./server-methods/sessions-create.js";
import { sessionMessagingHandlers } from "./server-methods/sessions-messaging.js";
import type { GatewayRequestHandler, RespondFn } from "./server-methods/types.js";
import {
  installAgentAuthorityProofFixture,
  PNG,
} from "./server.agent-runtime-authority-proof.test-support.js";
import { agentCommandMock, dispatchInboundMessageMock } from "./test-helpers.js";

const handlers: Record<string, GatewayRequestHandler> = {
  "chat.send": handleDirectExternalChatSend,
  agent: agentHandlers.agent!,
  "sessions.send": sessionMessagingHandlers["sessions.send"]!,
  "sessions.create": sessionCreateHandlers["sessions.create"]!,
};

const fixture = installAgentAuthorityProofFixture();
const uploadsDisabled = { code: "FORBIDDEN", details: { code: "UPLOADS_DISABLED" } };
const cached = expect.objectContaining({ cached: true });
const attachment = (kind = "inline-image") => ({
  mimeType: kind === "document" ? "text/plain" : "image/png",
  fileName: kind === "document" ? "proof.txt" : "proof.png",
  content: (kind === "document"
    ? Buffer.from("late upload policy proof")
    : Buffer.concat([
        Buffer.from(PNG, "base64"),
        Buffer.alloc(kind === "offloaded-image" ? 2_000_001 : 0),
      ])
  ).toString("base64"),
});
function expectDenied(respond: ReturnType<typeof vi.fn<RespondFn>>) {
  expect(respond.mock.calls.some(([ok]) => ok)).toBe(false);
  expect(respond.mock.calls.at(-1)?.[2]).toMatchObject(uploadsDisabled);
}
async function prepare() {
  const f = await fixture({ imageCapable: true });
  const original = f.context.getCommittedRuntimeConfig;
  const config = f.context.getRuntimeConfig();
  let enabled = true;
  f.context.getCommittedRuntimeConfig = () => ({
    ...config,
    gateway: { ...config.gateway, uploads: { enabled } },
  });
  return {
    ...f,
    disable: () => {
      enabled = false;
    },
    [Symbol.asyncDispose]: async () => {
      f.context.getCommittedRuntimeConfig = original;
      await f.cleanup();
    },
  };
}
function request(
  f: Awaited<ReturnType<typeof prepare>>,
  method: string,
  params: Record<string, unknown>,
  receipt = false,
) {
  return {
    req: { type: "req", id: receipt ? "receipt-wire-id" : f.runId, method, params },
    params,
    client: {
      connId: receipt ? "upload-receipt-proof" : "upload-policy-proof",
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        role: "operator",
        scopes: ["operator.admin"],
        client: { id: "cli", mode: "cli", platform: "test", version: "test" },
        ...(receipt
          ? {
              device: {
                id: "upload-receipt-device",
                publicKey: "synthetic",
                signature: "synthetic",
                signedAt: 1,
                nonce: "synthetic",
              },
            }
          : {}),
      },
    },
    context: f.context,
    isWebchatConnect: () => false,
  } satisfies Omit<Parameters<GatewayRequestHandler>[0], "respond">;
}

async function invoke(options: ReturnType<typeof request>, req = options.req) {
  const respond = vi.fn<RespondFn>();
  await handleGatewayRequest({ ...options, req, respond });
  return respond;
}

it.each(["chat.send", "sessions.send", "sessions.steer", "sessions.create"] as const)(
  "replays accepted %s uploads after disable without admitting fresh bytes",
  async (method) => {
    await using f = await prepare();
    const params = {
      agentId: "main",
      ...(method === "chat.send"
        ? { sessionKey: f.sessionKey }
        : { key: method === "sessions.create" ? f.sessionKey + "-created" : f.sessionKey }),
      message: "Accepted upload receipt",
      idempotencyKey: f.runId,
      attachments: [attachment()],
    };
    const send = (requestParams = params) => invoke(request(f, method, requestParams, true));
    const accepted = await send();
    expect(accepted.mock.calls.at(-1)?.[0]).toBe(true);
    await f.drain();
    const baseline = await send();
    const receipt = baseline.mock.calls.at(-1)!;
    expect(receipt[0]).toBe(true);
    expect(receipt[3]).toMatchObject({ cached: true });
    const mediaDir = path.join(getMediaDir(), "inbound");
    const files = await fs.readdir(mediaDir);
    const dispatches = dispatchInboundMessageMock.mock.calls.length;
    f.disable();
    const replay = await send();
    expect(replay).toHaveBeenCalledExactlyOnceWith(receipt[0], receipt[1], receipt[2], cached);
    const freshRunId = randomUUID();
    const denied = await send({ ...params, idempotencyKey: freshRunId });
    expect(denied.mock.calls.at(-1)?.[2]).toMatchObject(uploadsDisabled);
    expect(f.context.dedupe.has("chat:" + freshRunId)).toBe(false);
    expect(await fs.readdir(mediaDir)).toEqual(files);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(dispatches);
  },
);

it.each([
  ["chat.send", "inline-image", "policy"],
  ["chat.send", "offloaded-image", "policy"],
  ["chat.send", "document", "policy"],
  ["agent", "inline-image", "policy"],
  ["agent", "offloaded-image", "policy"],
  ["sessions.send", "inline-image", "policy"],
  ["sessions.create", "document", "policy"],
  ["agent", "offloaded-image", "stop"],
  ["agent", "offloaded-image", "stop-and-policy"],
] as const)(
  "settles %s %s when %s interrupts the real media writer",
  async (method, kind, interruption) => {
    await using f = await prepare();
    const mediaDir = path.join(getMediaDir(), "inbound");
    const before = await fs.readdir(mediaDir).catch(() => [] as string[]);
    const entered = createDeferred();
    const resume = createDeferred();
    const mkdir = fs.mkdir.bind(fs);
    let intercepted = false;
    const pause = vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
      const result = await mkdir(...args);
      if (!intercepted && String(args[0]) === mediaDir) {
        intercepted = true;
        entered.resolve();
        await resume.promise;
      }
      return result;
    });
    const requestParams = {
      agentId: "main",
      ...(method === "sessions.create"
        ? { key: `agent:main:upload-create:${f.runId}` }
        : method === "sessions.send"
          ? { key: f.sessionKey }
          : { sessionKey: f.sessionKey }),
      message: "Inspect this attachment",
      ...(method === "sessions.create" ? {} : { idempotencyKey: f.runId }),
      attachments: [attachment(kind)],
    };
    const respond = vi.fn<RespondFn>();
    const handlerOptions = { ...request(f, method, requestParams), respond };
    const pending = Promise.resolve(handlers[method]!(handlerOptions));
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        pending,
        "handler finished before entering the media writer",
      );
      let stoppedPayload: unknown;
      if (interruption !== "policy") {
        const abortRespond = vi.fn<RespondFn>();
        const abortParams = { sessionKey: f.sessionKey, agentId: "main", runId: f.runId };
        await handleChatAbortRequest({
          ...handlerOptions,
          req: { type: "req", id: f.runId + "-stop", method: "chat.abort", params: abortParams },
          params: abortParams,
          respond: abortRespond,
        });
        expect(abortRespond.mock.calls.at(-1)?.[1]).toMatchObject({ aborted: true });
        stoppedPayload = f.context.dedupe.get(`agent:${f.runId}`)?.payload;
        expect(stoppedPayload).toMatchObject({
          runId: f.runId,
          sessionKey: f.sessionKey,
          status: "timeout",
          stopReason: "rpc",
        });
      }
      if (interruption !== "stop") {
        f.disable();
      }
      resume.resolve();
      await pending;
      await f.drain();
      expect(intercepted).toBe(true);
      if (interruption !== "policy") {
        expect(respond).toHaveBeenCalledExactlyOnceWith(true, stoppedPayload, undefined, cached);
        expect(f.context.dedupe.get(`agent:${f.runId}`)?.payload).toEqual(stoppedPayload);
        if (interruption === "stop-and-policy") {
          const replay = await invoke(handlerOptions, {
            ...handlerOptions.req,
            id: f.runId + "-retry",
          });
          expect(replay).toHaveBeenCalledExactlyOnceWith(true, stoppedPayload, undefined, cached);
          const freshParams = { ...requestParams, idempotencyKey: f.runId + "-fresh" };
          const freshRespond = await invoke(handlerOptions, {
            ...handlerOptions.req,
            id: f.runId + "-fresh",
            params: freshParams,
          });
          expectDenied(freshRespond);
          expect(f.context.dedupe.has(`agent:${f.runId}-fresh`)).toBe(false);
        }
      } else if (method === "sessions.create") {
        // Creation remains committed; only its initial input is rejected.
        expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({
          runStarted: false,
          runError: uploadsDisabled,
        });
      } else {
        expectDenied(respond);
      }
      expect(await fs.readdir(mediaDir)).toEqual(before);
      expect(agentCommandMock).not.toHaveBeenCalled();
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await Promise.allSettled([pending]);
      pause.mockRestore();
    }
  },
);
