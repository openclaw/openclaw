import { createServer } from "node:http";
import { createSandboxHostHttpRequestHandler } from "../../../src/gateway/mcp-app-sandbox-http.js";

type FixtureResource = {
  body: string | Buffer;
  contentType: string;
  headers?: Record<string, string>;
};

/** Serve parser resources natively: new opaque child renderers can race browser interception. */
export function createControlUiSandboxFixtureServer(
  readResource: (pathname: string) => FixtureResource | undefined = () => undefined,
) {
  const sandbox = createSandboxHostHttpRequestHandler();
  return createServer((request, response) => {
    const resource = readResource(new URL(request.url ?? "/", "http://localhost").pathname);
    if (!resource) {
      void sandbox(request, response);
      return;
    }
    response.writeHead(200, {
      "content-type": resource.contentType,
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
      ...resource.headers,
    });
    response.end(request.method === "HEAD" ? undefined : resource.body);
  });
}
