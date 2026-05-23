import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  resolveLegacyAgentAccessToken,
  resolveLegacyPiAgentAccessToken,
} from "./provider-usage.js";

async function withLegacyAgentAuthFile(
  contents: string,
  run: (home: string) => Promise<void> | void,
): Promise<void> {
  await withTempDir({ prefix: "openclaw-provider-usage-sdk-" }, async (home) => {
    await fs.mkdir(path.join(home, ".pi", "agent"), { recursive: true });
    await fs.writeFile(path.join(home, ".pi", "agent", "auth.json"), contents, "utf8");
    await run(home);
  });
}

describe("plugin-sdk/provider-usage legacy compatibility", () => {
  it.each([
    {
      name: "reads legacy agent auth tokens for external plugin compatibility",
      contents: `${JSON.stringify({ "z-ai": { access: "legacy-zai-key" } }, null, 2)}\n`,
      expected: "legacy-zai-key",
    },
    {
      name: "returns undefined for invalid legacy agent auth files",
      contents: "{not-json",
      expected: undefined,
    },
  ])("$name", async ({ contents, expected }) => {
    await withLegacyAgentAuthFile(contents, async (home) => {
      expect(resolveLegacyAgentAccessToken({ HOME: home }, ["z-ai", "zai"])).toBe(expected);
      expect(resolveLegacyPiAgentAccessToken({ HOME: home }, ["z-ai", "zai"])).toBe(expected);
    });
  });
});
