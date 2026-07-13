import { afterEach, describe, expect, test, vi } from "vitest";
import { MAX_HISTORY_CHARS, MAX_MESSAGE_CHARS } from "./session-tools-contract.js";
import { visibleMessages } from "./session-tools-projection.js";
import {
  closeSessionTools,
  connectSessionTools,
  predictableSessionId,
  structuredContent,
} from "./session-tools.test-support.js";

afterEach(closeSessionTools);

describe("OpenClaw session MCP tools", () => {
  test("returns only bounded user and assistant text from history", async () => {
    const sessionKey = "agent:ops:dashboard:secret";
    const longText = "x".repeat(21_000);
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          sessions: [
            {
              key: sessionKey,
              label: "Deploy review",
              updatedAt: 1_767_995_121_286,
            },
          ],
        };
      }
      if (method === "agents.list") {
        return {
          defaultId: "main",
          agents: [{ id: "ops", identity: { emoji: "🦞" } }],
        };
      }
      if (method === "chat.history") {
        return {
          messages: [
            {
              id: "user-1",
              role: "user",
              content: [
                { type: "text", text: "Please review the deploy" },
                { type: "tool_use", name: "shell", input: { path: "/private/repo" } },
              ],
            },
            { id: "assistant-1", role: "assistant", content: "Review complete" },
            {
              role: "assistant",
              content: [
                { type: "text", text: longText },
                { type: "thinking", text: "private reasoning" },
              ],
            },
            { role: "system", content: "secret system prompt" },
            { role: "tool", content: "secret tool output" },
          ],
        };
      }
      throw new Error(`unexpected gateway method ${method}`);
    });
    const { client } = await connectSessionTools({
      request,
      methods: ["sessions.list", "agents.list", "chat.history"],
      scopes: ["operator.read"],
    });
    const listed = await client.callTool({ name: "openclaw_sessions_list", arguments: {} });
    const sessionId = (structuredContent(listed).items as Array<{ id: string }>)[0]?.id;

    const detail = await client.callTool({
      name: "openclaw_session_detail",
      arguments: { session_id: sessionId, limit: 100 },
    });

    const payload = structuredContent(detail);
    expect(payload.session).toMatchObject({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      agentId: "ops",
      title: "Deploy review",
    });
    expect(payload.messages).toEqual([
      { role: "user", text: "Please review the deploy" },
      { role: "assistant", text: "Review complete" },
      { role: "assistant", text: "x".repeat(20_000) },
    ]);
    expect(request).toHaveBeenCalledWith("chat.history", {
      sessionKey,
      agentId: "ops",
      limit: 100,
      maxChars: 200_000,
    });
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain(sessionKey);
    expect(serialized).not.toContain("private reasoning");
    expect(serialized).not.toContain("secret system prompt");
    expect(serialized).not.toContain("secret tool output");
    expect(serialized).not.toContain("/private/repo");
  });

  test("preserves the newest turns when the aggregate history budget is full", () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({
      role: "assistant",
      content: `${String(index).padStart(2, "0")}${"x".repeat(MAX_MESSAGE_CHARS - 2)}`,
    }));

    const visible = visibleMessages(messages);

    expect(visible).toHaveLength(10);
    expect(visible[0]?.text.startsWith("02")).toBe(true);
    expect(visible.at(-1)?.text.startsWith("11")).toBe(true);
    expect(visible.every((message) => message.text.length <= MAX_MESSAGE_CHARS)).toBe(true);
    expect(visible.reduce((total, message) => total + message.text.length, 0)).toBeLessThanOrEqual(
      MAX_HISTORY_CHARS,
    );
  });

  test("creates, sends, aborts, and updates through least-privilege session methods", async () => {
    const sessionKey = "agent:ops:dashboard:new-private-key";
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "sessions.create") {
        return {
          ok: true,
          key: sessionKey,
          runStarted: true,
          runId: "run-create",
          entry: { label: params.label, updatedAt: 1_767_995_121_286 },
        };
      }
      if (method === "sessions.send") {
        return { status: "started", runId: "run-send", key: sessionKey };
      }
      if (method === "sessions.abort") {
        return { ok: true, abortedRunId: "run-send", status: "aborted", key: sessionKey };
      }
      if (method === "sessions.patch") {
        return {
          ok: true,
          key: sessionKey,
          path: "/private/session-store",
          entry: {
            label: params.label,
            archivedAt: params.archived ? 1_767_995_121_286 : undefined,
            pinnedAt: params.pinned ? 1_767_995_121_286 : undefined,
            markedUnreadAt: params.unread ? 1_767_995_121_286 : undefined,
            updatedAt: 1_767_995_121_286,
          },
        };
      }
      throw new Error(`unexpected gateway method ${method}`);
    });
    const { client } = await connectSessionTools({
      request,
      methods: ["sessions.create", "sessions.send", "sessions.abort", "sessions.patch"],
      scopes: ["operator.write"],
    });

    const created = await client.callTool({
      name: "openclaw_session_create",
      arguments: { agent_id: "ops", label: "Release prep", message: "Start the review" },
    });
    const sessionId = (structuredContent(created).session as { id: string }).id;
    expect(structuredContent(created)).toMatchObject({
      session: {
        id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        agentId: "ops",
        title: "Release prep",
        status: "working",
      },
      run_id: "run-create",
    });
    expect(request).toHaveBeenCalledWith("sessions.create", {
      agentId: "ops",
      label: "Release prep",
      message: "Start the review",
    });

    const sent = await client.callTool({
      name: "openclaw_session_send",
      arguments: { session_id: sessionId, text: "Continue" },
    });
    expect(structuredContent(sent)).toMatchObject({
      session_id: sessionId,
      run_id: "run-send",
      status: "working",
    });
    expect(request).toHaveBeenCalledWith(
      "sessions.send",
      expect.objectContaining({
        key: sessionKey,
        agentId: "ops",
        message: "Continue",
        idempotencyKey: expect.any(String),
      }),
    );

    const aborted = await client.callTool({
      name: "openclaw_session_abort",
      arguments: { session_id: sessionId, run_id: "run-send" },
    });
    expect(structuredContent(aborted)).toMatchObject({
      session_id: sessionId,
      aborted: true,
      status: "idle",
    });
    expect(request).toHaveBeenCalledWith("sessions.abort", {
      key: sessionKey,
      agentId: "ops",
      runId: "run-send",
    });

    const updated = await client.callTool({
      name: "openclaw_session_update",
      arguments: {
        session_id: sessionId,
        label: "Release ready",
        archived: true,
        pinned: false,
        unread: true,
      },
    });
    expect(structuredContent(updated)).toMatchObject({
      session: {
        id: sessionId,
        title: "Release ready",
        archived: true,
        pinned: false,
        unread: true,
      },
    });
    expect(JSON.stringify(updated)).not.toContain(sessionKey);
    expect(JSON.stringify(updated)).not.toContain("/private/session-store");
  });

  test("returns the created session with a safe initial-message failure signal", async () => {
    const { client } = await connectSessionTools({
      request: async () => ({
        ok: true,
        key: "agent:main:dashboard:created-without-run",
        runStarted: false,
        runError: "private provider failure with credentials",
        entry: { label: "Created session" },
      }),
      methods: ["sessions.create"],
      scopes: ["operator.write"],
    });

    const result = await client.callTool({
      name: "openclaw_session_create",
      arguments: { message: "Please keep this draft" },
    });

    expect(result.isError).not.toBe(true);
    expect(structuredContent(result)).toMatchObject({
      session: {
        id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        title: "Created session",
        status: "idle",
      },
      initial_message_status: "failed",
    });
    expect(JSON.stringify(result)).not.toContain("private provider failure");
    expect(JSON.stringify(result)).not.toContain("credentials");
  });

  test("reuses client operation ids across create and send retries", async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "sessions.create") {
        return { key: params.key, runStarted: true, runId: "create-run", entry: {} };
      }
      if (method === "sessions.send") {
        return { runId: "send-run" };
      }
      throw new Error(`unexpected gateway method ${method}`);
    });
    const { client } = await connectSessionTools({
      request,
      methods: ["sessions.create", "sessions.send"],
      scopes: ["operator.write"],
    });

    const firstCreate = await client.callTool({
      name: "openclaw_session_create",
      arguments: {
        agent_id: "ops",
        message: "Create once",
        operation_id: "create-operation",
      },
    });
    const secondCreate = await client.callTool({
      name: "openclaw_session_create",
      arguments: {
        agent_id: "ops",
        message: "Create once",
        operation_id: "create-operation",
      },
    });
    const sessionId = (structuredContent(firstCreate).session as { id: string }).id;
    expect((structuredContent(secondCreate).session as { id: string }).id).toBe(sessionId);

    const createCalls = request.mock.calls.filter(([method]) => method === "sessions.create");
    expect(createCalls[0]?.[1]).toMatchObject({
      agentId: "ops",
      key: expect.stringMatching(/^agent:ops:dashboard:codex-/),
    });
    expect(createCalls[0]?.[1].message).toBeUndefined();
    expect(createCalls[0]?.[1]).not.toHaveProperty("idempotencyKey");
    expect(createCalls[1]?.[1]).toEqual(createCalls[0]?.[1]);

    const initialSendCalls = request.mock.calls.filter(
      ([method, params]) => method === "sessions.send" && params.message === "Create once",
    );
    expect(initialSendCalls).toHaveLength(2);
    expect(initialSendCalls[0]?.[1]).toMatchObject({
      idempotencyKey: "create-operation",
    });
    expect(initialSendCalls[1]?.[1]).toMatchObject({
      idempotencyKey: "create-operation",
    });

    await client.callTool({
      name: "openclaw_session_send",
      arguments: {
        session_id: sessionId,
        text: "Send once",
        operation_id: "send-operation",
      },
    });
    await client.callTool({
      name: "openclaw_session_send",
      arguments: {
        session_id: sessionId,
        text: "Send once",
        operation_id: "send-operation",
      },
    });

    const sendCalls = request.mock.calls.filter(
      ([method, params]) => method === "sessions.send" && params.message === "Send once",
    );
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[0]?.[1]).toMatchObject({ idempotencyKey: "send-operation" });
    expect(sendCalls[1]?.[1]).toMatchObject({ idempotencyKey: "send-operation" });
  });

  test("bounds configured agent icons when opening the new-session route", async () => {
    const avatar = `data:image/png;base64,${"A".repeat(250 * 1024)}`;
    const { client } = await connectSessionTools({
      request: async () => ({
        defaultId: "main",
        agents: Array.from({ length: 40 }, (_, index) => ({
          id: `agent-${index}`,
          identity: { avatarUrl: avatar },
        })),
      }),
      methods: ["sessions.create", "agents.list"],
      scopes: ["operator.write"],
    });

    const result = await client.callTool({
      name: "openclaw_session_detail",
      arguments: { mode: "new", chrome: "detail" },
    });
    const agents = structuredContent(result).agents as Array<{ icon?: { src: string } }>;
    const iconCount = agents.filter((agent) => agent.icon != null).length;

    expect(agents).toHaveLength(40);
    expect(iconCount).toBeGreaterThan(0);
    expect(iconCount).toBeLessThan(40);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(5 * 1024 * 1024);
  });

  test("uses advertised chat fallbacks and never guesses an unknown opaque id", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.create") {
        return { ok: true, key: "agent:main:dashboard:fallback", entry: {} };
      }
      if (method === "chat.send") {
        return { runId: "run-fallback" };
      }
      if (method === "chat.abort") {
        return { aborted: true };
      }
      throw new Error(`unexpected gateway method ${method}`);
    });
    const { client } = await connectSessionTools({
      request,
      methods: ["sessions.create", "chat.history", "chat.send", "chat.abort"],
      scopes: ["operator.write"],
    });
    const created = await client.callTool({
      name: "openclaw_session_create",
      arguments: {},
    });
    const sessionId = (structuredContent(created).session as { id: string }).id;

    await client.callTool({
      name: "openclaw_session_send",
      arguments: { session_id: sessionId, text: "fallback send" },
    });
    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "agent:main:dashboard:fallback",
        message: "fallback send",
      }),
    );

    await client.callTool({
      name: "openclaw_session_abort",
      arguments: { session_id: sessionId },
    });
    expect(request).toHaveBeenCalledWith("chat.abort", {
      sessionKey: "agent:main:dashboard:fallback",
      agentId: "main",
    });

    const missing = await client.callTool({
      name: "openclaw_session_detail",
      arguments: { session_id: predictableSessionId("unknown-session") },
    });
    expect(missing.isError).toBe(true);
    expect(structuredContent(missing)).toEqual({ error: { code: "refresh_required" } });
    expect(JSON.stringify(missing)).not.toContain("Gateway");
  });
});
