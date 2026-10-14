import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  persistBoundedClobberedConfigSnapshot,
  persistBoundedClobberedConfigSnapshotSync,
} from "./io.clobber-snapshot.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const limit = 32;
const timestamp = (index: number) => `2026-05-03T00:00:${String(index).padStart(2, "0")}.000Z`;
function fixture() {
  const dir = roots.make("openclaw-config-clobber-");
  const configPath = path.join(dir, "openclaw.json");
  fs.writeFileSync(configPath, "{}\n");
  const warn = vi.fn();
  const params = (index: number, observedAt = timestamp(0)) => ({
    deps: { fs, logger: { warn } },
    configPath,
    raw: `polluted-${index}\n`,
    observedAt,
  });
  const files = () =>
    fs.readdirSync(dir).filter((name) => name.startsWith("openclaw.json.clobbered."));
  const contents = () => files().map((name) => fs.readFileSync(path.join(dir, name), "utf8"));
  return { dir, warn, params, files, contents };
}

describe("config clobber snapshots", () => {
  it("serializes concurrent snapshots under the cap with one rotation warning", async () => {
    const f = fixture();
    const paths = await Promise.all(
      Array.from({ length: limit + 24 }, (_, index) =>
        persistBoundedClobberedConfigSnapshot(f.params(index)),
      ),
    );
    expect(paths).not.toContain(null);
    expect(f.files()).toHaveLength(limit);
    expect(f.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Config clobber snapshot cap reached"),
    );
  });

  it("rotates by artifact timestamp rather than mutable mtime", async () => {
    const f = fixture();
    for (let index = 0; index < limit; index++) {
      await persistBoundedClobberedConfigSnapshot(f.params(index, timestamp(index)));
    }
    const oldest = f
      .files()
      .find((name) => fs.readFileSync(path.join(f.dir, name), "utf8") === "polluted-0\n");
    expect(oldest).toBeDefined();
    const future = new Date("2026-05-03T01:00:00.000Z");
    await fsp.utimes(path.join(f.dir, oldest!), future, future);
    await persistBoundedClobberedConfigSnapshot(f.params(limit, "2026-05-03T00:01:00.000Z"));
    expect(f.files()).toHaveLength(limit);
    expect(f.contents()).not.toContain("polluted-0\n");
    expect(f.contents()).toContain(`polluted-${limit}\n`);
    expect(f.warn).toHaveBeenCalledOnce();
  });

  it.each([persistBoundedClobberedConfigSnapshot, persistBoundedClobberedConfigSnapshotSync])(
    "rotates reused same-timestamp artifacts through %s",
    async (persist) => {
      const f = fixture();
      for (let index = 0; index < limit; index++) {
        const artifact = await persist(f.params(index));
        expect(artifact).not.toBeNull();
        const touched = new Date(timestamp(index));
        await fsp.utimes(artifact!, touched, touched);
      }
      for (let index = limit; index < limit + 3; index++) {
        await persist(f.params(index));
      }
      expect(f.files()).toHaveLength(limit);
      const contents = f.contents();
      expect(contents).not.toContain("polluted-0\n");
      expect(contents).not.toContain("polluted-1\n");
      expect(contents).not.toContain("polluted-2\n");
      expect(contents).toContain(`polluted-${limit + 2}\n`);
    },
  );
});
