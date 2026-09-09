import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";

const lifetime = createFixtureLifetime();
const repository = fileURLToPath(new URL("../../", import.meta.url));
const runner = fileURLToPath(
  new URL("../../test/fixtures/mcp-registration/runner.mjs", import.meta.url),
);
afterAll(() => lifetime.cleanup());

describe("standalone MCP registration lifetime", () => {
  it.each(["plain", "nested", "close-failure"])(
    "%s: joins native tool work and physical registration disposal before terminal return",
    (mode) =>
      lifetime.run(async () => {
        const root = lifetime.createTempDir("openclaw-mcp-registration-");
        const result = await runNodeScript(
          [runner, repository, mode, root],
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
