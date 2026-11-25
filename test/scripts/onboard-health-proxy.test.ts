import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

it("preserves startup diagnostics and fails only the Classic health command", async () => {
  const backend = createServer((_request, response) => response.end('{"ready":true}'));
  const sockets = new WebSocketServer({ server: backend });
  const forwarded: string[] = [];
  let backendHealthAttempts = 0;
  sockets.on("connection", (socket) => {
    let mode: string;
    socket.on("message", (raw) => {
      const request = JSON.parse(
        Array.isArray(raw)
          ? Buffer.concat(raw).toString("utf8")
          : raw instanceof ArrayBuffer
            ? Buffer.from(raw).toString("utf8")
            : raw.toString("utf8"),
      );
      if (request.method === "connect") {
        mode = request.params.client.mode;
      } else {
        forwarded.push(`${mode}:${request.method}`);
      }
      const preflightFailure =
        mode === "cli" && request.method === "health" && ++backendHealthAttempts === 1;
      socket.send(
        JSON.stringify({
          type: "res",
          id: request.id,
          ok: !preflightFailure,
          ...(preflightFailure
            ? { error: { code: "UNAVAILABLE", message: "synthetic preflight retry" } }
            : { payload: { ready: true } }),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => {
    backend.listen(0, "127.0.0.1", resolve);
  });
  const backendAddress = backend.address();
  if (!backendAddress || typeof backendAddress === "string") {
    throw new Error("Missing backend port");
  }
  const child = spawn(
    process.execPath,
    ["scripts/e2e/lib/onboard/reachable-unhealthy-gateway.mjs"],
    {
      env: {
        ...process.env,
        OPENCLAW_ONBOARD_FIXTURE_PORT: "0",
        OPENCLAW_ONBOARD_BACKEND_PORT: String(backendAddress.port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  const exited = once(child, "exit");
  try {
    await vi.waitFor(() => expect(output).toMatch(/QA_ONBOARD_PROXY_PORT=\d+/));
    const port = /QA_ONBOARD_PROXY_PORT=(\d+)/.exec(output)![1];
    const url = `http://127.0.0.1:${port}`;
    await expect(
      fetch(`${url}/startupz`, { signal: AbortSignal.timeout(1_000) }).then((response) =>
        response.json(),
      ),
    ).resolves.toEqual({ ready: true });
    for (const [index, mode] of ["probe", "cli", "cli", "backend"].entries()) {
      const socket = new WebSocket(url.replace("http:", "ws:"));
      try {
        await once(socket, "open", { signal: AbortSignal.timeout(2_000) });
        const connected = once(socket, "message", { signal: AbortSignal.timeout(2_000) });
        socket.send(
          JSON.stringify({
            type: "req",
            id: "connect",
            method: "connect",
            params: { client: { mode } },
          }),
        );
        await connected;
        const response = once(socket, "message", { signal: AbortSignal.timeout(2_000) });
        socket.send(JSON.stringify({ type: "req", id: "health", method: "health" }));
        expect(JSON.parse(String((await response)[0]))).toMatchObject({
          id: "health",
          ok: index === 0 || index === 2,
        });
      } finally {
        socket.terminate();
      }
    }
    expect(forwarded).toEqual(["probe:health", "cli:health", "cli:health"]);
    await vi.waitFor(() => expect(output).toContain("QA_ONBOARD_HEALTH_FAULT"));
    expect(output).toContain("QA_ONBOARD_HEALTH_PREFLIGHT_OK");
  } finally {
    child.kill("SIGTERM");
    await exited;
    for (const socket of sockets.clients) {
      socket.terminate();
    }
    sockets.close();
    await new Promise<void>((resolve) => {
      backend.close(() => resolve());
    });
  }
});
