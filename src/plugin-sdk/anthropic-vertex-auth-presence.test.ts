import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasAnthropicVertexAvailableAuth } from "./anthropic-vertex-auth-presence.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("hasAnthropicVertexAvailableAuth", () => {
  it("preserves unicode GOOGLE_APPLICATION_CREDENTIALS paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-vertex-auth-"));
    tempDirs.push(root);
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
});
