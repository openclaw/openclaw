import { once } from "node:events";
// OpenWebUI probe tests cover QA Lab OpenAI-compatible API evidence.
import { createServer, type RequestListener, type Server as HttpServer } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { expect, it } from "vitest";
import { respondJson } from "../../../helpers/gateway-integration-fixtures.js";
import { runNodeScript } from "../../../helpers/run-node-script.js";

const probePath = path.resolve("scripts/e2e/openwebui-probe.mjs");

async function listen(server: HttpServer | TcpServer): Promise<string> {
  await once(server.listen(0, "127.0.0.1"), "listening");
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

async function probe(
  routes: Record<string, RequestListener>,
  env: Record<string, string> = {},
  timeout = 3_000,
) {
  const server = createServer((request, response) => {
    const handler = routes[request.url ?? ""];
    if (handler) {
      handler(request, response);
    } else {
      response.writeHead(404).end();
    }
  });
  try {
    return await runProbe(await listen(server), env, timeout);
  } finally {
    server.close();
  }
}

function json(body: unknown, status = 200): RequestListener {
  return (_request, response) => respondJson(response, body, status);
}

function signin(token = "test-token", cookie = "test"): RequestListener {
  return (_request, response) => {
    response.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": `openwebui-session=${cookie}; Path=/`,
    });
    response.end(JSON.stringify({ token }));
  };
}

function expectFailure(result: Awaited<ReturnType<typeof runProbe>>, message: string) {
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(message);
}

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

    expectFailure(result, "Open WebUI signin timed out after 25ms");
    expect(elapsedMs).toBeLessThan(1500);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    server.close();
  }
});

it("keeps the control-plane timeout active while reading sign-in bodies", async () => {
  const result = await probe(
    {
      "/api/v1/auths/signin": (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.flushHeaders();
        response.write("{");
      },
    },
    { OPENWEBUI_CONTROL_TIMEOUT_MS: "25", OPENWEBUI_FETCH_TIMEOUT_MS: "5000" },
    2_000,
  );
  expectFailure(result, "Open WebUI signin timed out after 25ms");
});

it("bounds sign-in error response bodies", async () => {
  const result = await probe(
    {
      "/api/v1/auths/signin": (_request, response) => {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("x".repeat(64));
      },
    },
    { OPENWEBUI_RESPONSE_BODY_MAX_BYTES: "16" },
  );
  expectFailure(result, "Open WebUI signin response body exceeded 16 bytes");
  expect(result.stderr).not.toContain("x".repeat(64));
});

it("redacts admin credentials from sign-in error bodies", async () => {
  const adminEmail = "openwebui-e2e@example.com";
  const result = await probe(
    {
      "/api/v1/auths/signin": json(
        { error: "invalid credentials", email: adminEmail, password: 'pa"ss' },
        401,
      ),
    },
    { OPENWEBUI_ADMIN_PASSWORD: 'pa"ss' },
  );
  expectFailure(result, "signin failed: HTTP 401");
  expect(result.stderr).toContain("<redacted>");
  for (const secret of [adminEmail, 'pa"ss', 'pa\\"ss']) {
    expect(result.stderr).not.toContain(secret);
  }
});

it("redacts auth material from model-list error bodies", async () => {
  const result = await probe({
    "/api/v1/auths/signin": signin("model-secret-token", "model=secret=cookie"),
    "/api/models": json(
      {
        error: "upstream rejected Authorization Bearer model-secret-token",
        cookieValue: "model=secret=cookie",
      },
      502,
    ),
  });
  expectFailure(result, "HTTP 502");
  expect(result.stderr).toContain("<redacted>");
  expect(result.stderr).not.toContain("model-secret-token");
  expect(result.stderr).not.toContain("model=secret=cookie");
});

it("does not sleep after the final model-list attempt", async () => {
  const result = await probe(
    {
      "/api/v1/auths/signin": signin("chat-secret-token", "chat=secret=cookie"),
      "/api/models": json({ data: [{ id: "other-model" }] }),
    },
    {
      OPENWEBUI_MODEL_ATTEMPTS: "1",
      OPENWEBUI_MODEL_RETRY_MS: "1500",
    },
    1_000,
  );
  expectFailure(result, "openclaw model missing from Open WebUI model list");
});

it("passes in models mode when Open WebUI exposes the OpenClaw model", async () => {
  const result = await probe(
    {
      "/api/v1/auths/signin": (request, response) => {
        setTimeout(() => {
          signin()(request, response);
        }, 25);
      },
      "/api/models": (request, response) => {
        expect(request.headers.authorization).toBe("Bearer test-token");
        expect(request.headers.cookie).toContain("openwebui-session=test");
        respondJson(response, { data: [{ id: "openclaw/default" }] });
      },
    },
    {
      OPENWEBUI_CONTROL_TIMEOUT_MS: String(MAX_TIMER_TIMEOUT_MS + 1),
      OPENWEBUI_FETCH_TIMEOUT_MS: String(MAX_TIMER_TIMEOUT_MS + 1),
    },
  );
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    mode: "models",
    model: "openclaw/default",
    ok: true,
  });
});

it("fails chat mode when the Open WebUI reply omits the expected nonce", async () => {
  const result = await probe(
    {
      "/api/v1/auths/signin": signin(),
      "/api/models": json({ data: [{ id: "openclaw/default" }] }),
      "/api/chat/completions": (request, response) => {
        const authorization = request.headers.authorization ?? "";
        const cookie = request.headers.cookie ?? "";
        respondJson(response, {
          message: {
            content: `missing the marker with ${authorization} and ${cookie}`,
          },
        });
      },
    },
    { OPENWEBUI_SMOKE_MODE: "chat" },
  );
  expectFailure(result, "chat reply missing nonce");
  expect(result.stderr).toContain("<redacted>");
  expect(result.stderr).not.toContain("test-token");
  expect(result.stderr).not.toContain("openwebui-session=test");
});
