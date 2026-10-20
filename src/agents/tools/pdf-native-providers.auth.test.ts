import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import * as pdfNativeProviders from "./pdf-native-providers.js";

type CapturedRequest = {
  authorizationUsesExpectedBearer: boolean;
  xApiKeyPresent: boolean;
  xApiKeyUsesExpectedOverride: boolean;
  anthropicBeta: string;
  userAgentIsClaudeCode: boolean;
  xAppIsCli: boolean;
  browserAccessIsEnabled: boolean;
  documentCount: number;
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
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      messages?: Array<{ content?: Array<{ type?: string }> }>;
    };
    requests.push({
      authorizationUsesExpectedBearer:
        request.headers.authorization === "Bearer sk-ant-oat01-fixture-token",
      xApiKeyPresent: typeof request.headers["x-api-key"] === "string",
      xApiKeyUsesExpectedOverride: request.headers["x-api-key"] === "fixture-explicit-api-key",
      anthropicBeta: request.headers["anthropic-beta"]?.toString() ?? "",
      userAgentIsClaudeCode: /^claude-cli\/\d+\.\d+\.\d+$/.test(
        request.headers["user-agent"]?.toString() ?? "",
      ),
      xAppIsCli: request.headers["x-app"] === "cli",
      browserAccessIsEnabled:
        request.headers["anthropic-dangerous-direct-browser-access"] === "true",
      documentCount:
        body.messages?.[0]?.content?.filter((block) => block.type === "document").length ?? 0,
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
  it("routes a setup-token credential through the maintained Claude Code identity", async () => {
    const fixture = await startFixture();
    try {
      await pdfNativeProviders.anthropicAnalyzePdf({
        apiKey: "sk-ant-oat01-fixture-token",
        modelId: "claude-opus-5-5",
        prompt: "Summarize this PDF",
        pdfs: [{ base64: "dGVzdA==" }],
        baseUrl: fixture.baseUrl,
      });

      expect(fixture.requests).toHaveLength(1);
      const request = firstCapturedRequest(fixture.requests);
      expect(request).toMatchObject({
        authorizationUsesExpectedBearer: true,
        xApiKeyPresent: false,
        userAgentIsClaudeCode: true,
        xAppIsCli: true,
        browserAccessIsEnabled: true,
        documentCount: 1,
      });
      const betaHeaders = request.anthropicBeta.split(",").map((value) => value.trim());
      expect(betaHeaders).toContain("claude-code-20250219");
      expect(betaHeaders).toContain("oauth-2025-04-20");
      expect(betaHeaders).toContain("pdfs-2024-09-25");
    } finally {
      await fixture.close();
    }
  });

  it("keeps API-key auth on x-api-key", async () => {
    const fixture = await startFixture();
    try {
      await pdfNativeProviders.anthropicAnalyzePdf({
        apiKey: "fixture-api-key",
        modelId: "claude-opus-5-5",
        prompt: "Summarize this PDF",
        pdfs: [{ base64: "dGVzdA==" }],
        baseUrl: fixture.baseUrl,
      });

      expect(fixture.requests).toHaveLength(1);
      const request = firstCapturedRequest(fixture.requests);
      expect(request.xApiKeyPresent).toBe(true);
      expect(request.documentCount).toBe(1);
      const betaHeaders = request.anthropicBeta.split(",").map((value) => value.trim());
      expect(betaHeaders).toContain("pdfs-2024-09-25");
      expect(betaHeaders).not.toContain("oauth-2025-04-20");
      expect(request.userAgentIsClaudeCode).toBe(false);
    } finally {
      await fixture.close();
    }
  });

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
