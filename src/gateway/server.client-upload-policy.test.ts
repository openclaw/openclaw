// Real RPC owners and media filesystem; only inference uses the shared Gateway fixture.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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

describe("client upload policy at the input commit owner", () => {
  const fixture = installAgentAuthorityProofFixture();

  it.each([
    "chat.send",
    "sessions.send",
    "sessions.steer",
    "sessions.create",
    "direct-chat",
  ] as const)(
    "replays accepted %s uploads after disable without admitting fresh bytes",
    async (route) => {
      const f = await fixture({ imageCapable: true });
      const originalConfig = f.context.getCommittedRuntimeConfig;
      const initialConfig = f.context.getRuntimeConfig();
      let enabled = true;
      f.context.getCommittedRuntimeConfig = () => ({
        ...initialConfig,
        gateway: { ...initialConfig.gateway, uploads: { enabled } },
      });
      const method = route === "direct-chat" ? "chat.send" : route;
      const params = {
        agentId: "main",
        ...(method === "chat.send"
          ? { sessionKey: f.sessionKey }
          : { key: method === "sessions.create" ? f.sessionKey + "-created" : f.sessionKey }),
        message: "Accepted upload receipt",
        idempotencyKey: f.runId,
        attachments: [{ mimeType: "image/png", fileName: "proof.png", content: PNG }],
      };
      const invoke = async (requestParams = params) => {
        const respond = vi.fn<RespondFn>();
        const options = {
          req: { type: "req" as const, id: "receipt-wire-id", method, params: requestParams },
          params: requestParams,
          client: {
            connId: "upload-receipt-proof",
            connect: {
              minProtocol: 1,
              maxProtocol: 1,
              role: "operator" as const,
              scopes: ["operator.admin"],
              client: { id: "cli", mode: "cli", platform: "test", version: "test" },
              device: {
                id: "upload-receipt-device",
                publicKey: "synthetic",
                signature: "synthetic",
                signedAt: 1,
                nonce: "synthetic",
              },
            },
          },
          context: f.context,
          respond,
          isWebchatConnect: () => false,
        } satisfies Parameters<GatewayRequestHandler>[0];
        if (route === "direct-chat") {
          await handleDirectExternalChatSend(options);
        } else {
          await handleGatewayRequest(options);
        }
        return respond;
      };
      try {
        const accepted = await invoke();
        expect(accepted.mock.calls.at(-1)?.[0]).toBe(true);
        await f.drain();
        const baseline = await invoke();
        const receipt = baseline.mock.calls.at(-1)!;
        expect(receipt[0]).toBe(true);
        expect(receipt[3]).toMatchObject({ cached: true });
        const mediaDir = path.join(getMediaDir(), "inbound");
        const files = await fs.readdir(mediaDir);
        const dispatches = dispatchInboundMessageMock.mock.calls.length;
        enabled = false;
        const replay = await invoke();
        expect(replay).toHaveBeenCalledExactlyOnceWith(
          receipt[0],
          receipt[1],
          receipt[2],
          expect.objectContaining({ cached: true }),
        );
        const freshRunId = randomUUID();
        const denied = await invoke({ ...params, idempotencyKey: freshRunId });
        expect(denied.mock.calls.at(-1)?.[2]).toMatchObject({
          code: "FORBIDDEN",
          details: { code: "UPLOADS_DISABLED" },
        });
        expect(f.context.dedupe.has("chat:" + freshRunId)).toBe(false);
        expect(await fs.readdir(mediaDir)).toEqual(files);
        expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(dispatches);
      } finally {
        f.context.getCommittedRuntimeConfig = originalConfig;
        await f.cleanup();
      }
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
      const f = await fixture({ imageCapable: true });
      const originalCommittedConfig = f.context.getCommittedRuntimeConfig;
      const initialConfig = f.context.getRuntimeConfig();
      let committedConfig: OpenClawConfig = {
        ...initialConfig,
        gateway: { ...initialConfig.gateway, uploads: { enabled: true } },
      };
      f.context.getCommittedRuntimeConfig = () => committedConfig;
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
      const respond = vi.fn<RespondFn>();
      const content =
        kind === "document"
          ? Buffer.from("late upload policy proof")
          : Buffer.concat([
              Buffer.from(PNG, "base64"),
              Buffer.alloc(kind === "offloaded-image" ? 2_000_001 : 0),
            ]);
      const requestParams = {
        agentId: "main",
        ...(method === "sessions.create"
          ? { key: `agent:main:upload-create:${f.runId}` }
          : method === "sessions.send"
            ? { key: f.sessionKey }
            : { sessionKey: f.sessionKey }),
        message: "Inspect this attachment",
        ...(method === "sessions.create" ? {} : { idempotencyKey: f.runId }),
        attachments: [
          {
            mimeType: kind === "document" ? "text/plain" : "image/png",
            fileName: kind === "document" ? "proof.txt" : "proof.png",
            content: content.toString("base64"),
          },
        ],
      };
      const handlerOptions = {
        req: { type: "req", id: f.runId, method, params: requestParams },
        params: requestParams,
        client: {
          connId: "upload-policy-proof",
          connect: {
            minProtocol: 1,
            maxProtocol: 1,
            role: "operator",
            scopes: ["operator.admin"],
            client: { id: "cli", mode: "cli", platform: "test", version: "test" },
          },
        },
        context: f.context,
        respond,
        isWebchatConnect: () => false,
      } satisfies Parameters<GatewayRequestHandler>[0];
      const pending = Promise.resolve(handlers[method]!(handlerOptions));
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("handler finished before entering the media writer");
          }),
        ]);
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
          committedConfig = {
            ...committedConfig,
            gateway: { ...committedConfig.gateway, uploads: { enabled: false } },
          };
        }
        resume.resolve();
        await pending;
        await f.drain();
        expect(intercepted).toBe(true);
        if (interruption !== "policy") {
          expect(respond).toHaveBeenCalledExactlyOnceWith(
            true,
            stoppedPayload,
            undefined,
            expect.objectContaining({ cached: true }),
          );
          expect(f.context.dedupe.get(`agent:${f.runId}`)?.payload).toEqual(stoppedPayload);
          if (interruption === "stop-and-policy") {
            const replayRespond = vi.fn<RespondFn>();
            await handleGatewayRequest({
              ...handlerOptions,
              req: { ...handlerOptions.req, id: f.runId + "-retry" },
              respond: replayRespond,
            });
            expect(replayRespond).toHaveBeenCalledExactlyOnceWith(
              true,
              stoppedPayload,
              undefined,
              expect.objectContaining({ cached: true }),
            );
            const freshRespond = vi.fn<RespondFn>();
            const freshParams = { ...requestParams, idempotencyKey: f.runId + "-fresh" };
            await handleGatewayRequest({
              ...handlerOptions,
              req: { ...handlerOptions.req, id: f.runId + "-fresh", params: freshParams },
              respond: freshRespond,
            });
            expect(freshRespond.mock.calls.some(([ok]) => ok)).toBe(false);
            expect(freshRespond.mock.calls.at(-1)?.[2]).toMatchObject({
              code: "FORBIDDEN",
              details: { code: "UPLOADS_DISABLED" },
            });
            expect(f.context.dedupe.has(`agent:${f.runId}-fresh`)).toBe(false);
          }
        } else if (method === "sessions.create") {
          // Creation remains committed; only its initial input is rejected.
          expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({
            runStarted: false,
            runError: { code: "FORBIDDEN", details: { code: "UPLOADS_DISABLED" } },
          });
        } else {
          expect(respond.mock.calls.some(([ok]) => ok)).toBe(false);
          expect(respond.mock.calls.at(-1)?.[2]).toMatchObject({
            code: "FORBIDDEN",
            details: { code: "UPLOADS_DISABLED" },
          });
        }
        expect(await fs.readdir(mediaDir)).toEqual(before);
        expect(agentCommandMock).not.toHaveBeenCalled();
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      } finally {
        resume.resolve();
        await Promise.allSettled([pending]);
        pause.mockRestore();
        f.context.getCommittedRuntimeConfig = originalCommittedConfig;
        await f.cleanup();
      }
    },
  );
});
