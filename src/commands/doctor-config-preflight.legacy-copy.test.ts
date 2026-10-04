import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";

const envKeys = ["HOME", "OPENCLAW_HOME", "OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"] as const;
function setEnv(values: Partial<Record<(typeof envKeys)[number], string>>) {
  for (const key of envKeys) {
    vi.stubEnv(key, values[key]);
  }
}
afterEach(() => vi.unstubAllEnvs());

describe("Doctor legacy config rename", () => {
  it("renames the config after root relocation and leaves a second pass unchanged", async () => {
    await withTempDir("openclaw-doctor-legacy-rename-", async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const legacyPath = path.join(stateDir, "clawdbot.json");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(stateDir);
      await fs.writeFile(legacyPath, "{}\n");
      const original = await fs.stat(legacyPath, { bigint: true });
      setEnv({ HOME: home });
      await runDoctorConfigPreflight({ migrateState: false, invalidConfigNote: false });
      const renamed = await fs.stat(configPath, { bigint: true });
      expect([renamed.dev, renamed.ino]).toEqual([original.dev, original.ino]);
      await expect(fs.readFile(configPath, "utf8")).resolves.toBe("{}\n");
      await expect(fs.stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
      await runDoctorConfigPreflight({ migrateState: false, invalidConfigNote: false });
      const again = await fs.stat(configPath, { bigint: true });
      expect([again.dev, again.ino, again.mtimeNs]).toEqual([
        renamed.dev,
        renamed.ino,
        renamed.mtimeNs,
      ]);
    });
  });

  it.each(["both-roots", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"] as const)(
    "leaves legacy config untouched with %s",
    async (selector) => {
      await withTempDir("openclaw-doctor-legacy-control-", async (home) => {
        const stateDir = path.join(home, ".openclaw");
        const source = path.join(stateDir, "clawdbot.json");
        const target = path.join(stateDir, "openclaw.json");
        await fs.mkdir(stateDir);
        await fs.writeFile(source, "{}\n");
        if (selector === "both-roots") {
          await fs.mkdir(path.join(home, ".clawdbot"));
        }
        setEnv({
          HOME: home,
          ...(selector === "both-roots"
            ? {}
            : {
                [selector]:
                  selector === "OPENCLAW_HOME"
                    ? home
                    : selector === "OPENCLAW_STATE_DIR"
                      ? stateDir
                      : target,
              }),
        });
        await runDoctorConfigPreflight({ migrateState: false, invalidConfigNote: false });
        await expect(fs.readFile(source, "utf8")).resolves.toBe("{}\n");
        await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );
});
