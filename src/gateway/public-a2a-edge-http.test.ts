import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentCommand, getFreePort, installGatewayTestHooks } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let startGatewayServer: typeof import("./server.js").startGatewayServer;
let server: Awaited<ReturnType<typeof startServer>>;
let port: number;

beforeAll(async () => {
  ({ startGatewayServer } = await import("./server.js"));
  port = await getFreePort();
  server = await startServer(port);
});

afterAll(async () => {
  await server.close({ reason: "public-a2a-edge suite done" });
});

async function startServer(portValue: number) {
  return await startGatewayServer(portValue, {
    host: "127.0.0.1",
    auth: { mode: "token", token: "secret" },
    controlUiEnabled: false,
  });
}

async function post(path: string, body: unknown, auth?: string) {
  return await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("public a2a edge HTTP", () => {
  it("serves unauthenticated public agent card", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const json = (await res.json()) as {
      kind?: string;
      endpoints?: {
        messageSend?: string;
        messageStream?: string;
        tasksGet?: string;
        tasksResubscribe?: string;
      };
      securitySchemes?: {
        messageSend?: string;
        messageStream?: string;
        tasksGet?: string;
        tasksResubscribe?: string;
      };
    };
    expect(json.kind).toBe("public-agent-card");
    expect(json.endpoints?.messageSend).toBe("/message/send");
    expect(json.endpoints?.messageStream).toBe("/message/stream");
    expect(json.endpoints?.tasksGet).toBe("/tasks/get");
    expect(json.endpoints?.tasksResubscribe).toBe("/tasks/resubscribe");
    expect(json.securitySchemes?.messageSend).toBe("bearer");
    expect(json.securitySchemes?.messageStream).toBe("bearer");
    expect(json.securitySchemes?.tasksGet).toBe("bearer");
    expect(json.securitySchemes?.tasksResubscribe).toBe("bearer");
  });

  it("rejects unauthenticated message/send", async () => {
    const res = await post("/message/send", { message: "hi" });
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated message/stream", async () => {
    const res = await post("/message/stream", { message: "hi" });
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated tasks/get", async () => {
    const res = await post("/tasks/get", {
      jsonrpc: "2.0",
      id: "req-unauth",
      method: "tasks/get",
      params: { taskId: "task_aaaaaaaaaaaaaaaaaaaaaaaa" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated tasks/resubscribe", async () => {
    const res = await post("/tasks/resubscribe", {
      jsonrpc: "2.0",
      id: "req-resub-unauth",
      method: "tasks/resubscribe",
      params: { taskId: "task_aaaaaaaaaaaaaaaaaaaaaaaa" },
    });
    expect(res.status).toBe(401);
  });

  it("returns projected taskId/contextId only for authenticated message/send", async () => {
    agentCommand.mockClear();
    agentCommand.mockResolvedValueOnce({ payloads: [{ text: "hello from send" }] } as never);

    const res = await post("/message/send", { model: "openclaw", message: "hi" }, "Bearer secret");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      task?: {
        taskId?: string;
        contextId?: string;
        status?: string;
        output?: { text?: string };
      };
    };
    expect(json.task?.taskId ?? "").toMatch(/^task_[0-9a-f]{24}$/);
    expect(json.task?.contextId ?? "").toMatch(/^ctx_[0-9a-f]{24}$/);
    expect(json.task?.status).toBe("completed");
    expect(json.task?.output?.text).toBe("hello from send");

    const callInput = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0] as
      | { runId?: string; sessionKey?: string }
      | undefined;
    expect(typeof callInput?.runId).toBe("string");
    expect(typeof callInput?.sessionKey).toBe("string");
    const internalRunId = callInput?.runId;
    const internalSessionKey = callInput?.sessionKey;

    const payloadText = JSON.stringify(json);
    if (typeof internalRunId === "string") {
      expect(payloadText).not.toContain(internalRunId);
    }
    if (typeof internalSessionKey === "string") {
      expect(payloadText).not.toContain(internalSessionKey);
    }
  });

  it("streams projected IDs only for authenticated message/stream", async () => {
    agentCommand.mockClear();
    agentCommand.mockResolvedValueOnce({ payloads: [{ text: "hello from stream" }] } as never);

    const res = await post(
      "/message/stream",
      { model: "openclaw", message: "stream me" },
      "Bearer secret",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");

    const streamText = await res.text();
    expect(streamText).toContain("event: task.started");
    expect(streamText).toContain("event: message.delta");
    expect(streamText).toContain("event: task.completed");
    expect(streamText).toContain("data: [DONE]");
    expect(streamText).toContain('"taskId":"task_');
    expect(streamText).toContain('"contextId":"ctx_');

    const callInput = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0] as
      | { runId?: string; sessionKey?: string }
      | undefined;
    expect(typeof callInput?.runId).toBe("string");
    expect(typeof callInput?.sessionKey).toBe("string");
    const internalRunId = callInput?.runId;
    const internalSessionKey = callInput?.sessionKey;
    if (typeof internalRunId === "string") {
      expect(streamText).not.toContain(internalRunId);
    }
    if (typeof internalSessionKey === "string") {
      expect(streamText).not.toContain(internalSessionKey);
    }
  });

  it("returns projected task only for authenticated tasks/get", async () => {
    agentCommand.mockClear();
    agentCommand.mockResolvedValueOnce({ payloads: [{ text: "lookup-seed" }] } as never);

    const sendRes = await post(
      "/message/send",
      { model: "openclaw", message: "seed task retrieval" },
      "Bearer secret",
    );
    expect(sendRes.status).toBe(200);
    const sendJson = (await sendRes.json()) as {
      task?: { taskId?: string; contextId?: string };
    };
    const taskId = sendJson.task?.taskId ?? "";
    const contextId = sendJson.task?.contextId ?? "";
    expect(taskId).toMatch(/^task_[0-9a-f]{24}$/);
    expect(contextId).toMatch(/^ctx_[0-9a-f]{24}$/);

    const seededCallInput = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0] as
      | { runId?: string; sessionKey?: string }
      | undefined;
    const internalRunId = seededCallInput?.runId;
    const internalSessionKey = seededCallInput?.sessionKey;

    const getRes = await post(
      "/tasks/get",
      {
        jsonrpc: "2.0",
        id: "req-task-get-1",
        method: "tasks/get",
        params: { taskId },
      },
      "Bearer secret",
    );
    expect(getRes.status).toBe(200);
    const getJson = (await getRes.json()) as {
      jsonrpc?: string;
      id?: string;
      result?: {
        task?: {
          taskId?: string;
          contextId?: string;
          status?: string;
          output?: { text?: string };
        };
      };
    };
    expect(getJson.jsonrpc).toBe("2.0");
    expect(getJson.id).toBe("req-task-get-1");
    expect(getJson.result?.task?.taskId).toBe(taskId);
    expect(getJson.result?.task?.contextId).toBe(contextId);
    expect(getJson.result?.task?.status).toBe("completed");
    expect(getJson.result?.task?.output?.text).toBe("lookup-seed");

    const payloadText = JSON.stringify(getJson);
    if (typeof internalRunId === "string") {
      expect(payloadText).not.toContain(internalRunId);
    }
    if (typeof internalSessionKey === "string") {
      expect(payloadText).not.toContain(internalSessionKey);
    }
  });

  it("returns bounded task-not-found error for unknown projected taskId", async () => {
    const res = await post(
      "/tasks/get",
      {
        jsonrpc: "2.0",
        id: "req-task-get-missing",
        method: "tasks/get",
        params: { taskId: "task_ffffffffffffffffffffffff" },
      },
      "Bearer secret",
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as {
      jsonrpc?: string;
      id?: string;
      error?: { code?: number; message?: string };
    };
    expect(json.jsonrpc).toBe("2.0");
    expect(json.id).toBe("req-task-get-missing");
    expect(json.error?.code).toBe(-32004);
    expect(json.error?.message).toBe("task not found");
  });

  it("returns SSE for authenticated tasks/resubscribe with projected IDs only", async () => {
    agentCommand.mockClear();
    agentCommand.mockResolvedValueOnce({ payloads: [{ text: "resub-seed" }] } as never);

    const sendRes = await post(
      "/message/send",
      { model: "openclaw", message: "seed resubscribe" },
      "Bearer secret",
    );
    expect(sendRes.status).toBe(200);
    const sendJson = (await sendRes.json()) as {
      task?: { taskId?: string; contextId?: string };
    };
    const taskId = sendJson.task?.taskId ?? "";
    const contextId = sendJson.task?.contextId ?? "";
    expect(taskId).toMatch(/^task_[0-9a-f]{24}$/);
    expect(contextId).toMatch(/^ctx_[0-9a-f]{24}$/);

    const seededCallInput = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0] as
      | { runId?: string; sessionKey?: string }
      | undefined;
    const internalRunId = seededCallInput?.runId;
    const internalSessionKey = seededCallInput?.sessionKey;

    const resubRes = await post(
      "/tasks/resubscribe",
      {
        jsonrpc: "2.0",
        id: "req-resub-ok",
        method: "tasks/resubscribe",
        params: { taskId },
      },
      "Bearer secret",
    );
    expect(resubRes.status).toBe(200);
    expect(resubRes.headers.get("content-type") ?? "").toContain("text/event-stream");
    const streamText = await resubRes.text();
    expect(streamText).toContain("event: message.delta");
    expect(streamText).toContain("event: task.completed");
    expect(streamText).toContain("data: [DONE]");
    expect(streamText).toContain(`"taskId":"${taskId}"`);
    expect(streamText).toContain(`"contextId":"${contextId}"`);
    if (typeof internalRunId === "string") {
      expect(streamText).not.toContain(internalRunId);
    }
    if (typeof internalSessionKey === "string") {
      expect(streamText).not.toContain(internalSessionKey);
    }
  });

  it("returns bounded task-not-found error for unknown tasks/resubscribe taskId", async () => {
    const res = await post(
      "/tasks/resubscribe",
      {
        jsonrpc: "2.0",
        id: "req-resub-missing",
        method: "tasks/resubscribe",
        params: { taskId: "task_ffffffffffffffffffffffff" },
      },
      "Bearer secret",
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as {
      jsonrpc?: string;
      id?: string;
      error?: { code?: number; message?: string };
    };
    expect(json.jsonrpc).toBe("2.0");
    expect(json.id).toBe("req-resub-missing");
    expect(json.error?.code).toBe(-32004);
    expect(json.error?.message).toBe("task not found");
  });
});
