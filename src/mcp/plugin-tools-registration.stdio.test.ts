import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { createCompiledSdkHost } from "../plugins/compiled-sdk-host.test-support.js";
import { mcpProviderCatalogEntrypoint } from "../plugins/loader-sdk-bridge-artifacts.test-support.js";

const lifetime = createFixtureLifetime();
const repository = fileURLToPath(new URL("../../", import.meta.url));
const runner = fileURLToPath(
  new URL("../../test/fixtures/mcp-registration/runner.mjs", import.meta.url),
);
let sdkHost: string | undefined;
beforeAll(() => {
  sdkHost = createCompiledSdkHost(mcpProviderCatalogEntrypoint, lifetime.createTempDir);
});
afterAll(() => lifetime.cleanup());

describe("standalone MCP registration lifetime", () => {
  it.each(["plain", "nested", "close-failure"])(
    "%s: joins native tool work and physical registration disposal before terminal return",
    (mode) =>
      lifetime.run(async () => {
        const root = lifetime.createTempDir("openclaw-mcp-registration-");
        const result = await runNodeScript(
          [runner, repository, mode, root, ...(sdkHost ? [sdkHost] : [])],
          { PATH: process.env.PATH },
          120_000,
          { cwd: repository, requireProcessTreeExit: true, maxBuffer: 1024 * 1024 },
        );
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
      }),
    135_000,
  );
});
