/**
 * Tests Anthropic Vertex auth presence helpers.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasAnthropicVertexAvailableAuth } from "./anthropic-vertex-auth-presence.js";
import { createPluginSdkTestHarness } from "./test-helpers.js";

const { createTempDir } = createPluginSdkTestHarness();

describe("hasAnthropicVertexAvailableAuth", () => {
  it("preserves unicode GOOGLE_APPLICATION_CREDENTIALS paths", async () => {
    const root = await createTempDir("openclaw-vertex-auth-");
    const unicodeDir = path.join(root, "認証情報");
    await fs.mkdir(unicodeDir, { recursive: true });
    const credentialsPath = path.join(unicodeDir, "application_default_credentials.json");
    await fs.writeFile(credentialsPath, "{}\n", "utf8");

    expect(
      hasAnthropicVertexAvailableAuth({
        GOOGLE_APPLICATION_CREDENTIALS: `  ${credentialsPath}  `,
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("rejects oversized ADC credential files instead of reading them fully", async () => {
    const root = await createTempDir("openclaw-vertex-auth-");
    const credentialsPath = path.join(root, "application_default_credentials.json");
    // 2 MiB exceeds the 1 MiB ADC read bound; the old unbounded readFileSync
    // would have slurped the whole file just to report it as readable.
    await fs.writeFile(credentialsPath, " ".repeat(2 * 1024 * 1024), "utf8");

    expect(
      hasAnthropicVertexAvailableAuth({
        GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});
