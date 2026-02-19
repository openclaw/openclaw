import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EDGEE_DEFAULT_MODEL_REF, setEdgeeApiKey } from "./onboard-auth.credentials.js";

describe("Edgee onboarding credentials", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("exports a default edgee model ref", () => {
    expect(EDGEE_DEFAULT_MODEL_REF).toBe("edgee/openai/gpt-4o");
  });

  it("writes edgee api key into auth profile store", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edgee-"));
    await setEdgeeApiKey("edgee-auth-key", tempDir);

    const raw = await fs.readFile(path.join(tempDir, "auth-profiles.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      profiles?: Record<string, { provider?: string; key?: string }>;
    };

    expect(parsed.profiles?.["edgee:default"]?.provider).toBe("edgee");
    expect(parsed.profiles?.["edgee:default"]?.key).toBe("edgee-auth-key");
  });
});
