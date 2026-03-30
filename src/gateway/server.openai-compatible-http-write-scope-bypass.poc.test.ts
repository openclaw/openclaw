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

      // Requests without x-openclaw-scopes header now receive default
      // CLI_DEFAULT_OPERATOR_SCOPES (which include operator.write), so they
      // are authorised.  The explicit-header test above still proves that a
      // caller who *declares* only operator.approvals is correctly rejected.
      agentCommand.mockClear();
      agentCommand.mockResolvedValueOnce({ payloads: [{ text: "hello" }] } as never);
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

      expect(missingHeaderRes.status).toBe(200);
      const missingHeaderBody = (await missingHeaderRes.json()) as {
        object?: string;
        choices?: Array<{ message?: { content?: string } }>;
      };
      expect(missingHeaderBody.object).toBe("chat.completion");
      expect(missingHeaderBody.choices?.[0]?.message?.content).toBe("hello");
      expect(agentCommand).toHaveBeenCalledTimes(1);
    } finally {
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("bearer auth cannot self-assert operator.write for /v1/chat/completions", async () => {
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

  test("bearer auth cannot self-assert operator.write for /v1/responses", async () => {
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

  test("bearer auth cannot use /tools/invoke", async () => {
    const started = await startServerWithClient("secret");

    try {
      const httpRes = await fetch(`http://127.0.0.1:${started.port}/tools/invoke`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tool: "agents_list",
          args: {},
        }),
      });

      expect(httpRes.status).toBe(403);
      const body = (await httpRes.json()) as {
        error?: { type?: string; message?: string };
      };
      expect(body.error?.type).toBe("forbidden");
      expect(body.error?.message).toBe("gateway bearer auth cannot invoke tools over HTTP");
    } finally {
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});
