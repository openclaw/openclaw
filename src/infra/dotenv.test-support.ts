import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { captureFullEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";

export function envContents(values: Record<string, string>) {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export async function writeEnvFile(filePath: string, contents: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

export function clearEnv(keys: readonly string[]) {
  keys.forEach(deleteTestEnvValue);
}

export function useDotEnvFixture() {
  const fixture = { base: "", cwdDir: "", stateDir: "" };
  let snapshot: ReturnType<typeof captureFullEnv>;
  beforeEach(async () => {
    snapshot = captureFullEnv();
    fixture.base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dotenv-test-"));
    fixture.cwdDir = path.join(fixture.base, "cwd");
    fixture.stateDir = path.join(fixture.base, "state");
    setTestEnvValue("OPENCLAW_STATE_DIR", fixture.stateDir);
    await fs.mkdir(fixture.cwdDir);
    await fs.mkdir(fixture.stateDir);
    vi.spyOn(process, "cwd").mockReturnValue(fixture.cwdDir);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    snapshot.restore();
  });
  return fixture;
}
