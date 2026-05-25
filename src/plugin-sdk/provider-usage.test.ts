import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  resolveLegacyAgentAccessToken,
  resolveLegacyPiAgentAccessToken,
} from "./provider-usage.js";

describe("plugin-sdk/provider-usage legacy compatibility", () => {
  it("keeps deprecated legacy token exports as no-op plugin-boundary stubs", async () => {
    await withTempDir({ prefix: "openclaw-provider-usage-sdk-" }, async (home) => {
      await fs.mkdir(path.join(home, ".pi", "agent"), { recursive: true });
      await fs.writeFile(
        path.join(home, ".pi", "agent", "auth.json"),
        `${JSON.stringify({ "z-ai": { access: "legacy-zai-key" } }, null, 2)}\n`,
        "utf8",
      );

      expect(resolveLegacyAgentAccessToken({ HOME: home }, ["z-ai", "zai"])).toBeUndefined();
      expect(resolveLegacyPiAgentAccessToken({ HOME: home }, ["z-ai", "zai"])).toBeUndefined();
    });
  });
});
