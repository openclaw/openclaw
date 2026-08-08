import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { postTrustedWebToolsJson } from "./web-search-provider-common.js";

const API_KEY = "orchid/River+17=glassMoth92~cabin";
const UNIQUE_NEEDLE = "glassMoth92";
const ERROR_BODY_CAP_BYTES = 64 * 1024;
const LOWERCASE_ENCODED_API_KEY = encodeURIComponent(API_KEY).replace(/%[0-9A-F]{2}/gu, (escape) =>
  escape.toLowerCase(),
);

async function listenOnLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe.sequential("web search provider error redaction", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("redacts a reflected credential through the trusted guarded transport", async () => {
    const receivedAuthorization: Array<string | undefined> = [];
    const server = createServer();
    server.on("connect", (_request, socket) => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      let requestBytes = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        requestBytes = Buffer.concat([requestBytes, chunk]);
        const headerEnd = requestBytes.indexOf("\r\n\r\n");
        if (headerEnd < 0) {
          return;
        }
        const [requestLine = "", ...headerLines] = requestBytes
          .subarray(0, headerEnd)
          .toString("utf8")
          .split("\r\n");
        const contentLengthLine = headerLines.find((line) =>
          line.toLowerCase().startsWith("content-length:"),
        );
        const contentLength = Number.parseInt(
          contentLengthLine?.slice(contentLengthLine.indexOf(":") + 1).trim() ?? "0",
          10,
        );
        if (requestBytes.length < headerEnd + 4 + contentLength) {
          return;
        }
        socket.off("data", onData);
        const authorizationLine = headerLines.find((line) =>
          line.toLowerCase().startsWith("authorization:"),
        );
        const authorization = authorizationLine?.slice(authorizationLine.indexOf(":") + 1).trim();
        receivedAuthorization.push(authorization);
        const [, requestTarget = "/"] = requestLine.split(" ");
        const pathname = new URL(requestTarget, "http://web-search-proof.test").pathname;
        const isError = pathname === "/v1/error";
        const reflectedCredential = authorization?.replace(/^Bearer\s+/u, "");
        const encodedReflection = reflectedCredential
          ? encodeURIComponent(reflectedCredential).replace(/%[0-9A-F]{2}/gu, (escape) =>
              escape.toLowerCase(),
            )
          : "";
        const retainedCredentialPrefixBytes = 12;
        const body = isError
          ? `${"x".repeat(ERROR_BODY_CAP_BYTES - retainedCredentialPrefixBytes)}${encodedReflection}; retry later`
          : '{"ok":true,"detail":"harmless response"}';
        socket.end(
          `HTTP/1.1 ${isError ? "401 Unauthorized" : "200 OK"}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        );
      };
      socket.on("data", onData);
    });
    const proxyUrl = await listenOnLoopback(server);
    vi.stubEnv("HTTP_PROXY", proxyUrl);
    vi.stubEnv("http_proxy", proxyUrl);
    vi.stubEnv("HTTPS_PROXY", proxyUrl);
    vi.stubEnv("https_proxy", proxyUrl);
    vi.stubEnv("ALL_PROXY", "");
    vi.stubEnv("all_proxy", "");
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("no_proxy", "");

    try {
      const error = await postTrustedWebToolsJson(
        {
          url: "http://web-search-proof.test/v1/error",
          timeoutSeconds: 5,
          apiKey: API_KEY,
          body: { query: "proof" },
          errorLabel: "Web search",
          maxErrorBytes: ERROR_BODY_CAP_BYTES,
        },
        async (response) => await response.json(),
      ).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Web search API error (401)");
      expect((error as Error).message).toContain("truncated diagnostic omitted");
      expect((error as Error).message).not.toContain(API_KEY);
      expect((error as Error).message).not.toContain(LOWERCASE_ENCODED_API_KEY);
      expect((error as Error).message).not.toContain(LOWERCASE_ENCODED_API_KEY.slice(0, 12));
      expect((error as Error).message).not.toContain(UNIQUE_NEEDLE);

      const control = await postTrustedWebToolsJson(
        {
          url: "http://web-search-proof.test/v1/ok",
          timeoutSeconds: 5,
          apiKey: API_KEY,
          body: { query: "proof" },
          errorLabel: "Web search",
        },
        async (response) => (await response.json()) as { ok: boolean; detail: string },
      );
      expect(control).toEqual({ ok: true, detail: "harmless response" });
      expect(receivedAuthorization).toEqual([`Bearer ${API_KEY}`, `Bearer ${API_KEY}`]);
    } finally {
      await closeServer(server);
    }
  });
});
