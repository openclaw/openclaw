import fs from "node:fs";
import path from "node:path";
import { it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";

it.skipIf(process.platform === "win32")(
  "reclaims a killed byte-copy creator and preserves its live tokens",
  async ({ expect, signal, onTestFinished }) => {
    const fixture = createFixtureLifetime();
    onTestFinished(() => fixture.cleanup());
    await fixture.run(async () => {
      const root = fixture.createTempDir("sqlite-reclamation-process-");
      const result = await fixture.track(
        runNodeScript(
          [
            "--import=tsx",
            new URL("../../scripts/perf/sqlite-staging-reclamation-measure.mts", import.meta.url)
              .pathname,
            "--root",
            root,
            "--gib",
            "0.125",
            "--sessions",
            "32",
            "--workspace-files",
            "0",
            "--stop-mib",
            "1",
            "--pairs",
            "1",
          ],
          {
            PATH: process.env.PATH,
            HOME: root,
            USERPROFILE: root,
            OPENCLAW_STATE_DIR: path.join(root, "state"),
            XDG_CACHE_HOME: path.join(root, "cache"),
            NODE_DISABLE_COMPILE_CACHE: "1",
            TSX_DISABLE_CACHE: "1",
          },
          60_000,
          { signal, maxBuffer: 1024 * 1024 },
        ),
      );
      expect(result, result.stderr).toMatchObject({ status: 0, error: undefined });
      const evidence = JSON.parse(result.stdout);
      expect(evidence.liveSafety).toHaveLength(2);
      for (const observation of evidence.liveSafety) {
        expect(observation.result).toEqual({ removed: 0, bytes: 0, skipped: 1 });
      }
      expect(evidence.preservedSessions).toEqual({ count: 32 });
      expect(evidence.records).toHaveLength(4);
      for (const record of evidence.records) {
        expect(record.copiedBytes).toBeGreaterThan(0);
        expect(record.copiedBytes).toBeLessThan(evidence.fixture.sourceBytes);
        expect(record.location).toMatch(/^(?:\.fs-safe-.*\.tmp|database\.sqlite\.partial)$/u);
        expect(record.retained).toBe(!record.label.startsWith("b"));
      }
      expect(evidence.records.at(-1).result).toEqual({
        removed: 1,
        bytes: evidence.records.at(-1).copiedBytes,
        skipped: 0,
      });
      expect(fs.readdirSync(root)).toEqual([]);
    });
  },
);
