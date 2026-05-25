import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const envKeys = [
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_PROJECT",
] as const;

const previousEnv = new Map<string, string | undefined>();
const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const key of envKeys) {
    const value = previousEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  previousEnv.clear();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.resetModules();
});

function setEnv(key: (typeof envKeys)[number], value: string): void {
  if (!previousEnv.has(key)) {
    previousEnv.set(key, process.env[key]);
  }
  process.env[key] = value;
}

describe("getEnvApiKey", () => {
  it("returns no env auth in browser contexts without process", async () => {
    vi.resetModules();
    const { findEnvKeys, getEnvApiKey } = await import("./env-api-keys.js");
    vi.stubGlobal("process", undefined);

    expect(findEnvKeys("openai")).toBeUndefined();
    expect(getEnvApiKey("openai")).toBeUndefined();
    expect(getEnvApiKey("google-vertex")).toBeUndefined();
    expect(getEnvApiKey("amazon-bedrock")).toBeUndefined();
  });

  it("detects Google Vertex ADC credentials on the first synchronous lookup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openclaw-vertex-adc-"));
    tempDirs.push(dir);
    const credentialsPath = join(dir, "application_default_credentials.json");
    await writeFile(credentialsPath, "{}", "utf-8");
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", credentialsPath);
    setEnv("GOOGLE_CLOUD_LOCATION", "us-central1");
    setEnv("GOOGLE_CLOUD_PROJECT", "vertex-project");

    vi.resetModules();
    const { getEnvApiKey } = await import("./env-api-keys.js");

    expect(getEnvApiKey("google-vertex")).toBe("<authenticated>");
  });
});
