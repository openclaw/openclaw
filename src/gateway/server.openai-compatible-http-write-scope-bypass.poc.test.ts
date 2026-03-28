import { describe, expect, test } from "vitest";
import {
  agentCommand,
  connectReq,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway OpenAI-compatible HTTP write-scope bypass PoC", () => {
  test("operator.approvals is denied by chat.send and /v1/chat/completions without operator.write", async () => {
    const started = await startServerWithClient("secret", {
      openAiChatCompletionsEnabled: true,
    });

    try {
      const connect = await connectReq(started.ws, {
        token: "secret",
        scopes: ["operator.approvals"],
      });
      expect(connect.ok).toBe(true);

      const wsSend = await rpcReq(started.ws, "chat.send", {
        sessionKey: "main",
        message: "hi",
      });
      expect(wsSend.ok).toBe(false);
      expect(wsSend.error?.message).toBe("missing scope: operator.write");

      agentCommand.mockClear();
      const httpRes = await fetch(`http://127.0.0.1:${started.port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
          "x-openclaw-scopes": "operator.approvals",
        },
        body: JSON.stringify({
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      expect(httpRes.status).toBe(403);
      const body = (await httpRes.json()) as {
        error?: { type?: string; message?: string };
      };
      expect(body.error?.type).toBe("forbidden");
      expect(body.error?.message).toBe("missing scope: operator.write");
      expect(agentCommand).toHaveBeenCalledTimes(0);

      agentCommand.mockClear();
      const missingHeaderRes = await fetch(`http://127.0.0.1:${started.port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      expect(missingHeaderRes.status).toBe(403);
      const missingHeaderBody = (await missingHeaderRes.json()) as {
        error?: { type?: string; message?: string };
      };
      expect(missingHeaderBody.error?.type).toBe("forbidden");
      expect(missingHeaderBody.error?.message).toBe("missing scope: operator.write");
      expect(agentCommand).toHaveBeenCalledTimes(0);
    } finally {
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("operator.write can still use /v1/chat/completions", async () => {
    const started = await startServerWithClient("secret", {
      openAiChatCompletionsEnabled: true,
    });

    try {
      agentCommand.mockClear();
      agentCommand.mockResolvedValueOnce({ payloads: [{ text: "hello" }] } as never);

      const httpRes = await fetch(`http://127.0.0.1:${started.port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
          "x-openclaw-scopes": "operator.write",
        },
        body: JSON.stringify({
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      expect(httpRes.status).toBe(200);
      const body = (await httpRes.json()) as {
        object?: string;
        choices?: Array<{ message?: { content?: string } }>;
      };
      expect(body.object).toBe("chat.completion");
      expect(body.choices?.[0]?.message?.content).toBe("hello");
      expect(agentCommand).toHaveBeenCalledTimes(1);
    } finally {
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("operator.approvals is denied by chat.send and /v1/responses without operator.write", async () => {
    const started = await startServerWithClient("secret", {
      openResponsesEnabled: true,
    });

    try {
      const connect = await connectReq(started.ws, {
        token: "secret",
        scopes: ["operator.approvals"],
      });
      expect(connect.ok).toBe(true);

      const wsSend = await rpcReq(started.ws, "chat.send", {
        sessionKey: "main",
        message: "hi",
      });
      expect(wsSend.ok).toBe(false);
      expect(wsSend.error?.message).toBe("missing scope: operator.write");

      agentCommand.mockClear();
      const httpRes = await fetch(`http://127.0.0.1:${started.port}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
          "x-openclaw-scopes": "operator.approvals",
        },
        body: JSON.stringify({
          stream: false,
          model: "openclaw",
          input: "hi",
        }),
      });

      expect(httpRes.status).toBe(403);
      const body = (await httpRes.json()) as {
        error?: { type?: string; message?: string };
      };
      expect(body.error?.type).toBe("forbidden");
      expect(body.error?.message).toBe("missing scope: operator.write");
      expect(agentCommand).toHaveBeenCalledTimes(0);
    } finally {
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("operator.write can still use /v1/responses", async () => {
    const started = await startServerWithClient("secret", {
      openResponsesEnabled: true,
    });

    try {
      agentCommand.mockClear();
      agentCommand.mockResolvedValueOnce({ payloads: [{ text: "hello" }] } as never);

      const httpRes = await fetch(`http://127.0.0.1:${started.port}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
          "x-openclaw-scopes": "operator.write",
        },
        body: JSON.stringify({
          stream: false,
          model: "openclaw",
          input: "hi",
        }),
      });

      expect(httpRes.status).toBe(200);
      const body = (await httpRes.json()) as {
        object?: string;
        status?: string;
        output?: Array<{
          type?: string;
          role?: string;
          content?: Array<{ type?: string; text?: string }>;
        }>;
      };
      expect(body.object).toBe("response");
      expect(body.status).toBe("completed");
      expect(body.output?.[0]?.type).toBe("message");
      expect(body.output?.[0]?.role).toBe("assistant");
      expect(body.output?.[0]?.content?.[0]?.type).toBe("output_text");
      expect(body.output?.[0]?.content?.[0]?.text).toBe("hello");
      expect(agentCommand).toHaveBeenCalledTimes(1);
    } finally {
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});
