import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { writeTextFileAtomic } from "./config-io.js";

// mock-isolation: Keep config runtime state outside this atomic text-write boundary test.
vi.mock("../config/config.js", () => ({ createConfigIO: vi.fn() }));

const tempDirs = createTrackedTempDirs();
afterEach(() => tempDirs.cleanup());

it.runIf(process.platform !== "win32").each([
  { directory: ".", expectedMode: 0o2770 },
  { directory: "credentials", expectedMode: 0o700 },
])(
  "keeps private text files without changing shared state-root mode: $directory",
  async ({ directory, expectedMode }) => {
    const stateDir = await tempDirs.make("secrets-state-mode-");
    const parent = path.join(stateDir, directory);
    fs.mkdirSync(parent, { recursive: true });
    fs.chmodSync(parent, 0o770);
    fs.chmodSync(stateDir, 0o2770);
    const target = path.join(parent, ".env");

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      writeTextFileAtomic(target, "SCRUBBED=\n");
    });

    expect(fs.readFileSync(target, "utf8")).toBe("SCRUBBED=\n");
    expect(fs.statSync(stateDir).mode & 0o7777).toBe(0o2770);
    expect(fs.statSync(parent).mode & 0o7777).toBe(expectedMode);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  },
);
