import { afterAll, beforeAll } from "vitest";
import { buildSandboxHostPath } from "../../../src/agents/sandbox-host.js";
import { createControlUiSandboxFixtureServer } from "../test-helpers/control-ui-sandbox-fixture-server.ts";

/** Supplies real sandbox metadata for mocked Canvas view responses in one suite. */
export function useCanvasSandboxFixture(
  readResource?: Parameters<typeof createControlUiSandboxFixtureServer>[0],
) {
  const server = createControlUiSandboxFixtureServer(readResource);
  let sandboxPort: number;
  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Canvas fixture sandbox did not bind a TCP port");
    }
    sandboxPort = address.port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  return (html: string) => ({
    html,
    sandboxUrl: buildSandboxHostPath({ blockDescendantFrames: true }),
    sandboxPort,
  });
}
