import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("debug proxy runtime capture context", () => {
  const envKeys = [
    "OPENCLAW_DEBUG_PROXY_ENABLED",
    "OPENCLAW_DEBUG_PROXY_DB_PATH",
    "OPENCLAW_DEBUG_PROXY_BLOB_DIR",
    "OPENCLAW_DEBUG_PROXY_SESSION_ID",
    "OPENCLAW_DEBUG_PROXY_SOURCE_PROCESS",
  ] as const;
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-capture-context-"));
    process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
    process.env.OPENCLAW_DEBUG_PROXY_DB_PATH = path.join(tempDir, "capture.sqlite");
    process.env.OPENCLAW_DEBUG_PROXY_BLOB_DIR = path.join(tempDir, "blobs");
    process.env.OPENCLAW_DEBUG_PROXY_SESSION_ID = "capture-session-test";
    process.env.OPENCLAW_DEBUG_PROXY_SOURCE_PROCESS = "vitest";
    vi.resetModules();
  });

  afterEach(async () => {
    const { closeDebugProxyCaptureStore } = await import("./store.sqlite.js");
    closeDebugProxyCaptureStore();
    vi.resetModules();
    for (const key of envKeys) {
      const value = savedEnv[key];
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("merges runtime session lineage into captured request metadata", async () => {
    const {
      captureHttpExchange,
      finalizeDebugProxyCapture,
      initializeDebugProxyCapture,
      runWithDebugProxyCaptureContext,
    } = await import("./runtime.js");
    const { getDebugProxyCaptureStore } = await import("./store.sqlite.js");

    initializeDebugProxyCapture("test-runtime-context");

    runWithDebugProxyCaptureContext(
      {
        sessionKey: "agent:main:subagent:planner",
        parentSessionKey: "agent:main:main",
        topLevelUserRequestId: "msg-123",
        messageId: "msg-123",
        agentId: "agent:main:subagent:planner",
        agentName: "planner",
        sourceSessionKey: "agent:main:main",
        sourceTool: "sessions_spawn",
        trigger: "user",
      },
      () => {
        captureHttpExchange({
          url: "https://api.openai.com/v1/responses",
          method: "POST",
          requestHeaders: { "content-type": "application/json" },
          requestBody: '{"input":"hello"}',
          response: new Response('{"ok":true}', {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
          meta: {
            captureOrigin: "guarded-fetch",
            provider: "openai",
            model: "gpt-5.4",
          },
        });
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    try {
      const store = getDebugProxyCaptureStore(
        process.env.OPENCLAW_DEBUG_PROXY_DB_PATH!,
        process.env.OPENCLAW_DEBUG_PROXY_BLOB_DIR!,
      );
      const events = store.getSessionEvents("capture-session-test", 20);
      const requestEvent = events.find((event) => event.kind === "request");
      expect(requestEvent).toBeTruthy();
      const metaJson = typeof requestEvent?.metaJson === "string" ? requestEvent.metaJson : "{}";
      const meta = JSON.parse(metaJson);
      expect(meta).toMatchObject({
        captureOrigin: "guarded-fetch",
        provider: "openai",
        model: "gpt-5.4",
        sessionKey: "agent:main:subagent:planner",
        parentSessionKey: "agent:main:main",
        top_level_user_request_id: "msg-123",
        message_id: "msg-123",
        agent_id: "agent:main:subagent:planner",
        parent_agent_id: "agent:main:main",
        sourceSessionKey: "agent:main:main",
        sourceTool: "sessions_spawn",
        trigger: "user",
        lineageSource: "runtime-context",
      });
    } finally {
      finalizeDebugProxyCapture();
    }
  });
});
