// Removed zalouser state tests cover doctor detection and deletion.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { removedZalouserStateCheck } from "./doctor-removed-zalouser-state-check.js";

const runtime = { log() {}, error() {}, exit() {} };

describe("removed zalouser state doctor check", () => {
  let root: string | undefined;

  async function createStateDir(fingerprint: "default" | "profile" = "default"): Promise<string> {
    root = await fs.mkdtemp(join(tmpdir(), "openclaw-zalouser-state-"));
    const staleDir = join(root, "credentials", "zalouser");
    await fs.mkdir(staleDir, { recursive: true });
    const filename = fingerprint === "default" ? "credentials.json" : "credentials-work.json";
    await fs.writeFile(join(staleDir, filename), "{}", "utf8");
    return staleDir;
  }

  afterEach(async () => {
    if (root !== undefined) {
      await fs.rm(root, { force: true, recursive: true });
      root = undefined;
    }
  });

  it("previews and removes the stale plugin credential directory", async () => {
    const staleDir = await createStateDir();

    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const findings = await removedZalouserStateCheck.detect({ mode: "lint", runtime, cfg: {} });
      expect(findings).toEqual([
        expect.objectContaining({
          checkId: "core/doctor/removed-zalouser-state",
          path: staleDir,
          severity: "warning",
        }),
      ]);
      await expect(
        removedZalouserStateCheck.detect(
          { mode: "fix", runtime, cfg: {} },
          { paths: [join(root!, "other")] },
        ),
      ).resolves.toEqual([]);

      const preview = await removedZalouserStateCheck.repair?.(
        { mode: "fix", runtime, cfg: {}, dryRun: true },
        findings,
      );
      expect(preview).toMatchObject({
        changes: [expect.stringContaining("Would remove removed zalouser plugin credential state")],
        effects: [
          {
            action: "would-remove-removed-zalouser-state",
            dryRunSafe: false,
            kind: "state",
            target: staleDir,
          },
        ],
      });
      await expect(fs.stat(staleDir)).resolves.toBeDefined();

      const repaired = await removedZalouserStateCheck.repair?.(
        { mode: "fix", runtime, cfg: {} },
        findings,
      );
      expect(repaired).toMatchObject({
        changes: [expect.stringContaining("Removed removed zalouser plugin credential state")],
        effects: [
          {
            action: "remove-removed-zalouser-state",
            dryRunSafe: false,
            kind: "state",
            target: staleDir,
          },
        ],
      });
      await expect(fs.stat(staleDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        removedZalouserStateCheck.detect({ mode: "lint", runtime, cfg: {} }),
      ).resolves.toEqual([]);
    });
  });

  it("detects the per-profile credential fingerprint", async () => {
    const staleDir = await createStateDir("profile");

    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      await expect(
        removedZalouserStateCheck.detect({ mode: "lint", runtime, cfg: {} }),
      ).resolves.toEqual([
        expect.objectContaining({
          checkId: "core/doctor/removed-zalouser-state",
          path: staleDir,
        }),
      ]);
    });
  });

  it("ignores an unrelated directory without credential fingerprints", async () => {
    root = await fs.mkdtemp(join(tmpdir(), "openclaw-zalouser-state-"));
    const otherDir = join(root, "credentials", "zalouser");
    await fs.mkdir(otherDir, { recursive: true });
    await fs.writeFile(join(otherDir, "notes.md"), "personal", "utf8");

    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      await expect(
        removedZalouserStateCheck.detect({ mode: "lint", runtime, cfg: {} }),
      ).resolves.toEqual([]);
      await expect(
        removedZalouserStateCheck.repair?.({ mode: "fix", runtime, cfg: {} }, []),
      ).resolves.toMatchObject({ status: "skipped", changes: [] });
      await expect(fs.readFile(join(otherDir, "notes.md"), "utf8")).resolves.toBe("personal");
    });
  });
});
