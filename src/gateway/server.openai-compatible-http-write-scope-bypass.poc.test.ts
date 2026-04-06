import { describe, expect, test } from "vitest";
import {
  agentCommand,
  connectReq,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway OpenAI-compatible HTTP shared-secret auth", () => {
  test("operator.approvals stays denied on WS chat.send but compat chat HTTP restores full operator defaults", async () => {
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

      expect(httpRes.status).toBe(200);
      const body = (await httpRes.json()) as {
        id?: string;
        object?: string;
      };
      expect(body.object).toBe("chat.completion");
      expect(agentCommand).toHaveBeenCalledTimes(1);
      const firstCall = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0] as
        | { senderIsOwner?: boolean }
        | undefined;
      expect(firstCall?.senderIsOwner).toBe(true);

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
      expect(agentCommand).toHaveBeenCalledTimes(1);
    } finally {
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("shared-secret bearer auth ignores narrower declared write scopes for /v1/chat/completions", async () => {
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
      expect(agentCommand).toHaveBeenCalledTimes(1);
    } finally {
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("operator.approvals stays denied on WS chat.send but compat responses HTTP restores full operator defaults", async () => {
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

      expect(httpRes.status).toBe(200);
      const body = (await httpRes.json()) as {
        object?: string;
      };
      expect(body.object).toBe("response");
      expect(agentCommand).toHaveBeenCalledTimes(1);
      const firstCall = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0] as
        | { senderIsOwner?: boolean }
        | undefined;
      expect(firstCall?.senderIsOwner).toBe(true);
    } finally {
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("shared-secret bearer auth ignores narrower declared write scopes for /v1/responses", async () => {
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
      expect(agentCommand).toHaveBeenCalledTimes(1);
    } finally {
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("shared-secret bearer auth can use /tools/invoke", async () => {
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

      expect(httpRes.status).toBe(200);
      const body = (await httpRes.json()) as {
        ok?: boolean;
        result?: unknown;
      };
      expect(body.ok).toBe(true);
      expect(body.result).toBeTruthy();
    } finally {
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});
