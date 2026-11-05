import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { writeTextFileAtomic } from "./config-io.js";

// mock-isolation: Keep config runtime state outside this atomic text-write boundary test.
vi.mock("../config/config.js", () => ({ createConfigIO: vi.fn() }));

const tempDirs = createTrackedTempDirs();
afterEach(async () => {
  vi.restoreAllMocks();
  await tempDirs.cleanup();
});

it.runIf(process.platform !== "win32").each([
  { directory: ".", expectedMode: 0o2770, mode: 0o600 },
  { directory: ".", expectedMode: 0o2770, mode: 0o640 },
  { directory: "credentials", expectedMode: 0o700, mode: 0o600 },
  { directory: "credentials", expectedMode: 0o700, mode: 0o640 },
])(
  "keeps text file mode $mode without changing shared state-root mode: $directory",
  async ({ directory, expectedMode, mode }) => {
    const stateDir = await tempDirs.make("secrets-state-mode-");
    const parent = path.join(stateDir, directory);
    fs.mkdirSync(parent, { recursive: true });
    fs.chmodSync(parent, 0o770);
    fs.chmodSync(stateDir, 0o2770);
    const target = path.join(parent, ".env");
    const rootStat = fs.statSync(stateDir);
    const fchmod = fs.fchmodSync;
    vi.spyOn(fs, "fchmodSync").mockImplementation((fd, requestedMode) => {
      const stat = fs.fstatSync(fd);
      if (stat.dev === rootStat.dev && stat.ino === rootStat.ino) {
        throw Object.assign(new Error("EPERM: shared root is not owned by this user"), {
          code: "EPERM",
        });
      }
      fchmod(fd, requestedMode);
    });

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      writeTextFileAtomic(target, "SCRUBBED=\n", mode);
    });

    expect(fs.readFileSync(target, "utf8")).toBe("SCRUBBED=\n");
    expect(fs.statSync(stateDir).mode & 0o7777).toBe(0o2770);
    expect(fs.statSync(parent).mode & 0o7777).toBe(expectedMode);
    expect(fs.statSync(target).mode & 0o777).toBe(mode);
  },
);

it.runIf(process.platform !== "win32")("creates a missing state root at 0700", async () => {
  const sharedParent = await tempDirs.make("secrets-new-state-mode-");
  fs.chmodSync(sharedParent, 0o2770);
  const stateDir = path.join(sharedParent, "state");
  const target = path.join(stateDir, ".env");
  writeTextFileAtomic(target, "SCRUBBED=\n", 0o640, { OPENCLAW_STATE_DIR: stateDir });
  expect(fs.statSync(stateDir).mode & 0o7777).toBe(0o700);
  expect(fs.statSync(target).mode & 0o777).toBe(0o640);
});
