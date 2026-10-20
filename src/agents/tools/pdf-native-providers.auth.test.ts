import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import * as pdfNativeProviders from "./pdf-native-providers.js";

type CapturedRequest = {
  authorizationUsesExpectedBearer: boolean;
  xApiKeyPresent: boolean;
  xApiKeyUsesExpectedOverride: boolean;
  anthropicBeta: string;
  userAgentIsClaudeCode: boolean;
};

function firstCapturedRequest(requests: CapturedRequest[]): CapturedRequest {
  const request = requests[0];
  if (!request) {
    throw new Error("expected a captured Anthropic PDF request");
  }
  return request;
}

async function startFixture() {
  const requests: CapturedRequest[] = [];
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    requests.push({
      authorizationUsesExpectedBearer:
        request.headers.authorization === "Bearer sk-ant-oat01-fixture-token",
      xApiKeyPresent: typeof request.headers["x-api-key"] === "string",
      xApiKeyUsesExpectedOverride: request.headers["x-api-key"] === "fixture-explicit-api-key",
      anthropicBeta: request.headers["anthropic-beta"]?.toString() ?? "",
      userAgentIsClaudeCode: /^claude-cli\/\d+\.\d+\.\d+$/.test(
        request.headers["user-agent"]?.toString() ?? "",
      ),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ content: [{ type: "text", text: "fixture response" }] }));
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("loopback fixture did not bind to a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}

describe("native Anthropic PDF auth", () => {
  it("honors an explicit API-key override for a setup-token credential", async () => {
    const fixture = await startFixture();
    try {
      await pdfNativeProviders.anthropicAnalyzePdf({
        apiKey: "sk-ant-oat01-fixture-token",
        modelId: "claude-opus-5-5",
        prompt: "Summarize this PDF",
        pdfs: [{ base64: "dGVzdA==" }],
        baseUrl: fixture.baseUrl,
        requestConfig: {
          request: {
            auth: { mode: "header", headerName: "x-api-key", value: "fixture-explicit-api-key" },
          },
        },
      });

      expect(fixture.requests).toHaveLength(1);
      const request = firstCapturedRequest(fixture.requests);
      expect(request).toMatchObject({
        authorizationUsesExpectedBearer: false,
        xApiKeyPresent: true,
        xApiKeyUsesExpectedOverride: true,
        userAgentIsClaudeCode: false,
      });
      expect(request.anthropicBeta.split(",").map((value) => value.trim())).not.toContain(
        "oauth-2025-04-20",
      );
    } finally {
      await fixture.close();
    }
  });

  it("preserves an explicit x-api-key request header over a setup-token credential", async () => {
    const fixture = await startFixture();
    try {
      await pdfNativeProviders.anthropicAnalyzePdf({
        apiKey: "sk-ant-oat01-fixture-token",
        modelId: "claude-opus-5-5",
        prompt: "Summarize this PDF",
        pdfs: [{ base64: "dGVzdA==" }],
        baseUrl: fixture.baseUrl,
        requestConfig: {
          request: {
            headers: { "x-api-key": "fixture-explicit-api-key" },
          },
        },
      });

      expect(fixture.requests).toHaveLength(1);
      const request = firstCapturedRequest(fixture.requests);
      expect(request).toMatchObject({
        authorizationUsesExpectedBearer: false,
        xApiKeyPresent: true,
        xApiKeyUsesExpectedOverride: true,
        userAgentIsClaudeCode: false,
      });
      expect(request.anthropicBeta.split(",").map((value) => value.trim())).not.toContain(
        "oauth-2025-04-20",
      );
    } finally {
      await fixture.close();
    }
  });
});
