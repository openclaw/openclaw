import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

it("preserves startup diagnostics and fails only the Classic health command", async () => {
  const backend = createServer((_request, response) => response.end('{"ready":true}'));
  const sockets = new WebSocketServer({ server: backend });
  const forwarded: string[] = [];
  sockets.on("connection", (socket) => {
    let mode: string;
    socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.method === "connect") {
        mode = request.params.client.mode;
      } else {
        forwarded.push(`${mode}:${request.method}`);
      }
      socket.send(
        JSON.stringify({ type: "res", id: request.id, ok: true, payload: { ready: true } }),
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
  const reservation = createServer();
  await new Promise<void>((resolve) => {
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing proxy port");
  }
  await new Promise<void>((resolve) => {
    reservation.close(() => resolve());
  });
  const child = spawn(
    process.execPath,
    ["scripts/e2e/lib/onboard/reachable-unhealthy-gateway.mjs"],
    {
      env: {
        ...process.env,
        OPENCLAW_ONBOARD_FIXTURE_PORT: String(address.port),
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
    await vi.waitFor(async () => {
      const socket = createConnection({ port: address.port, host: "127.0.0.1" });
      try {
        await once(socket, "connect");
      } finally {
        socket.destroy();
      }
    });
    const url = `http://127.0.0.1:${address.port}`;
    await expect(
      fetch(`${url}/startupz`, { signal: AbortSignal.timeout(1_000) }).then((response) =>
        response.json(),
      ),
    ).resolves.toEqual({ ready: true });
    for (const mode of ["probe", "cli"]) {
      const socket = new WebSocket(url.replace("http:", "ws:"));
      try {
        await once(socket, "open");
        const connected = once(socket, "message");
        socket.send(
          JSON.stringify({
            type: "req",
            id: "connect",
            method: "connect",
            params: { client: { mode } },
          }),
        );
        await connected;
        const response = once(socket, "message");
        socket.send(JSON.stringify({ type: "req", id: "health", method: "health" }));
        expect(JSON.parse(String((await response)[0]))).toMatchObject({
          id: "health",
          ok: mode === "probe",
        });
      } finally {
        socket.terminate();
      }
    }
    expect(forwarded).toEqual(["probe:health"]);
    await vi.waitFor(() => expect(output).toContain("QA_ONBOARD_HEALTH_FAULT"));
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
