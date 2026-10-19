// OpenWebUI probe tests cover QA Lab OpenAI-compatible API evidence.
import { createServer, type Server as HttpServer } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import { runNodeScript } from "../../../helpers/run-node-script.js";

const probePath = path.resolve("scripts/e2e/openwebui-probe.mjs");

async function listen(server: HttpServer | TcpServer): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

function runProbe(baseUrl: string, env: Record<string, string> = {}, timeout = 3_000) {
  return runNodeScript(
    probePath,
    {
      ...process.env,
      OPENWEBUI_ADMIN_EMAIL: "openwebui-e2e@example.com",
      OPENWEBUI_ADMIN_PASSWORD: "test-password",
      OPENWEBUI_BASE_URL: baseUrl,
      OPENWEBUI_CONTROL_TIMEOUT_MS: "250",
      OPENWEBUI_EXPECTED_NONCE: "nonce-123",
      OPENWEBUI_MODEL_ATTEMPTS: "1",
      OPENWEBUI_MODEL_RETRY_MS: "0",
      OPENWEBUI_PROMPT: "reply with nonce-123",
      OPENWEBUI_SMOKE_MODE: "models",
      ...env,
    },
    timeout,
  );
}

describe("scripts/e2e/openwebui-probe.mjs", () => {
  it("uses a short control-plane timeout for stalled sign-in requests", async () => {
    const sockets = new Set<Socket>();
    const server = createTcpServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("data", () => {});
    });
    const baseUrl = await listen(server);
    const startedAt = Date.now();
    try {
      const result = await runProbe(
        baseUrl,
        {
          OPENWEBUI_CONTROL_TIMEOUT_MS: "25",
          OPENWEBUI_FETCH_TIMEOUT_MS: "5000",
        },
        2_000,
      );
      const elapsedMs = Date.now() - startedAt;

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Open WebUI signin timed out after 25ms");
      expect(elapsedMs).toBeLessThan(1500);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close();
    }
  });

  it("keeps the control-plane timeout active while reading sign-in bodies", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/api/v1/auths/signin") {
        response.writeHead(200, { "content-type": "application/json" });
        response.flushHeaders();
        response.write("{");
        return;
      }
      response.writeHead(404).end();
    });
    const baseUrl = await listen(server);
    try {
      const result = await runProbe(
        baseUrl,
        {
          OPENWEBUI_CONTROL_TIMEOUT_MS: "25",
          OPENWEBUI_FETCH_TIMEOUT_MS: "5000",
        },
        2_000,
      );

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Open WebUI signin timed out after 25ms");
    } finally {
      server.close();
    }
  });

  it("bounds sign-in error response bodies", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/api/v1/auths/signin") {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("x".repeat(64));
        return;
      }
      response.writeHead(404).end();
    });
    const baseUrl = await listen(server);
    try {
      const result = await runProbe(baseUrl, {
        OPENWEBUI_RESPONSE_BODY_MAX_BYTES: "16",
      });

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Open WebUI signin response body exceeded 16 bytes");
      expect(result.stderr).not.toContain("x".repeat(64));
    } finally {
      server.close();
    }
  });

  it("redacts admin credentials from sign-in error bodies", async () => {
    const adminEmail = "openwebui-e2e@example.com";
    const server = createServer((request, response) => {
      if (request.url === "/api/v1/auths/signin") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: "invalid credentials",
            email: adminEmail,
            password: 'pa"ss',
          }),
        );
        return;
      }
      response.writeHead(404).end();
    });
    const baseUrl = await listen(server);
    try {
      const result = await runProbe(baseUrl, { OPENWEBUI_ADMIN_PASSWORD: 'pa"ss' });

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("signin failed: HTTP 401");
      expect(result.stderr).toContain("<redacted>");
      expect(result.stderr).not.toContain(adminEmail);
      expect(result.stderr).not.toContain('pa"ss');
      expect(result.stderr).not.toContain('pa\\"ss');
    } finally {
      server.close();
    }
  });

  it("redacts auth material from model-list error bodies", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/api/v1/auths/signin") {
        response.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": "openwebui-session=model=secret=cookie; Path=/",
        });
        response.end(JSON.stringify({ token: "model-secret-token" }));
        return;
      }
      if (request.url === "/api/models") {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: "upstream rejected Authorization Bearer model-secret-token",
            cookieValue: "model=secret=cookie",
          }),
        );
        return;
      }
      response.writeHead(404).end();
    });
    const baseUrl = await listen(server);
    try {
      const result = await runProbe(baseUrl);

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("HTTP 502");
      expect(result.stderr).toContain("<redacted>");
      expect(result.stderr).not.toContain("model-secret-token");
      expect(result.stderr).not.toContain("model=secret=cookie");
    } finally {
      server.close();
    }
  });

  it("does not sleep after the final model-list attempt", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/api/v1/auths/signin") {
        response.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": "openwebui-session=chat=secret=cookie; Path=/",
        });
        response.end(JSON.stringify({ token: "chat-secret-token" }));
        return;
      }
      if (request.url === "/api/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "other-model" }] }));
        return;
      }
      response.writeHead(404).end();
    });
    const baseUrl = await listen(server);
    try {
      const result = await runProbe(
        baseUrl,
        {
          OPENWEBUI_MODEL_ATTEMPTS: "1",
          OPENWEBUI_MODEL_RETRY_MS: "1500",
        },
        1_000,
      );

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("openclaw model missing from Open WebUI model list");
    } finally {
      server.close();
    }
  });

  it("passes in models mode when Open WebUI exposes the OpenClaw model", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/api/v1/auths/signin") {
        setTimeout(() => {
          response.writeHead(200, {
            "content-type": "application/json",
            "set-cookie": "openwebui-session=test; Path=/",
          });
          response.end(JSON.stringify({ token: "test-token" }));
        }, 25);
        return;
      }
      if (request.url === "/api/models") {
        expect(request.headers.authorization).toBe("Bearer test-token");
        expect(request.headers.cookie).toContain("openwebui-session=test");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "openclaw/default" }] }));
        return;
      }
      response.writeHead(404).end();
    });
    const baseUrl = await listen(server);
    try {
      const result = await runProbe(baseUrl, {
        OPENWEBUI_CONTROL_TIMEOUT_MS: String(MAX_TIMER_TIMEOUT_MS + 1),
        OPENWEBUI_FETCH_TIMEOUT_MS: String(MAX_TIMER_TIMEOUT_MS + 1),
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        mode: "models",
        model: "openclaw/default",
        ok: true,
      });
    } finally {
      server.close();
    }
  });

  it("fails chat mode when the Open WebUI reply omits the expected nonce", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/api/v1/auths/signin") {
        response.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": "openwebui-session=test; Path=/",
        });
        response.end(JSON.stringify({ token: "test-token" }));
        return;
      }
      if (request.url === "/api/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "openclaw/default" }] }));
        return;
      }
      if (request.url === "/api/chat/completions") {
        const authorization = request.headers.authorization ?? "";
        const cookie = request.headers.cookie ?? "";
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            message: {
              content: `missing the marker with ${authorization} and ${cookie}`,
            },
          }),
        );
        return;
      }
      response.writeHead(404).end();
    });
    const baseUrl = await listen(server);
    try {
      const result = await runProbe(baseUrl, { OPENWEBUI_SMOKE_MODE: "chat" });

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("chat reply missing nonce");
      expect(result.stderr).toContain("<redacted>");
      expect(result.stderr).not.toContain("test-token");
      expect(result.stderr).not.toContain("openwebui-session=test");
    } finally {
      server.close();
    }
  });
});
