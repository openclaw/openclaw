import { once } from "node:events";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import net, { type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintSecretSentinel } from "../sentinel.js";
import { startSecretEgressProxyServer, type SecretEgressProxyHandle } from "./proxy-server.js";

describe("authenticated loopback CONNECT", () => {
  const sockets = new Set<Socket>();
  let proxy: SecretEgressProxyHandle;
  let server: Server;
  let caDir: string;
  beforeEach(async () => {
    caDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-connect-http-"));
    proxy = await startSecretEgressProxyServer({ caDir, onAudit: () => {} });
  });
  afterEach(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    sockets.clear();
    await proxy.stop();
    server?.closeAllConnections();
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    fs.rmSync(caDir, { force: true, recursive: true });
  });
  async function listen(value: Server): Promise<number> {
    server = value;
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected loopback port");
    }
    return address.port;
  }
  const registeredPassword = (env: Record<string, string>) => new URL(env.HTTPS_PROXY!).password;
  const basicProxyAuth = (password: string) =>
    `Basic ${Buffer.from(`openclaw:${password}`).toString("base64")}`;
  it.each([
    { kind: "allowed", status: "200 OK" },
    { kind: "secret", status: "502 Bad Gateway" },
    { kind: "scheme", status: "400 Bad Request" },
    { kind: "host", status: "400 Bad Request" },
    { kind: "port", status: "400 Bad Request" },
  ])(
    "handles $kind literal loopback HTTP through an authenticated CONNECT tunnel",
    async ({ kind, status }) => {
      const requests: string[] = [];
      const port = await listen(
        createServer((request, response) => {
          requests.push(request.url ?? "");
          response.end("ok");
        }),
      );
      const endpoint = new URL(proxy.proxyOrigin);
      const socket = net.connect(Number(endpoint.port), endpoint.hostname);
      sockets.add(socket);
      socket.on("error", () => {});
      await once(socket, "connect");
      const auth = basicProxyAuth(registeredPassword(proxy.registerProcess().env));
      let output = "";
      socket.on("data", (chunk) => {
        output += chunk.toString();
      });
      socket.write(
        `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nProxy-Authorization: ${auth}\r\n\r\n`,
      );
      await vi.waitFor(() => expect(output).toContain("200 Connection Established"));
      output = "";
      const target =
        kind === "scheme"
          ? `https://127.0.0.1:${port}/ok`
          : kind === "host"
            ? `http://localhost:${port}/ok`
            : kind === "port"
              ? `http://127.0.0.1:${port + 1}/ok`
              : "/ok";
      const secret =
        kind === "secret"
          ? `Authorization: ${mintSecretSentinel("synthetic-cleartext-refusal", { label: "connect-http" })}\r\n`
          : "";
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${secret}Connection: close\r\n\r\n`,
      );
      await vi.waitFor(() => expect(output).toContain(status));
      expect(requests).toEqual(kind === "allowed" ? ["/ok"] : []);
    },
  );
});
