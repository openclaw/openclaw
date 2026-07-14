// Verifies plugins.load.paths security audit findings.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectPluginLoadPathFindings } from "./audit-plugin-load-paths.js";

describe("security audit plugin load path findings", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("returns no findings when plugins.load.paths is unset", async () => {
    const findings = await collectPluginLoadPathFindings({ cfg: {} satisfies OpenClawConfig });
    expect(findings).toEqual([]);
  });

  it.runIf(process.platform !== "win32")(
    "flags world-writable configured plugin load paths",
    async () => {
      const pluginDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "openclaw-load-path-audit-"),
      );
      tempDirs.push(pluginDir);
      fs.writeFileSync(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({ id: "demo", name: "Demo" }),
      );
      fs.writeFileSync(
        path.join(pluginDir, "index.ts"),
        "export default function register() {}",
        "utf-8",
      );
      fs.chmodSync(pluginDir, 0o777);

      const findings = await collectPluginLoadPathFindings({
        cfg: {
          plugins: {
            load: {
              paths: [pluginDir],
            },
          },
        } satisfies OpenClawConfig,
      });

      expect(
        findings.some(
          (finding) =>
            finding.checkId === "plugins.load_paths.world_writable" &&
            finding.severity === "critical",
        ),
      ).toBe(true);
      expect(
        findings.some((finding) => finding.checkId === "plugins.load_paths.trust_boundary"),
      ).toBe(true);
    },
  );

  it("flags missing configured plugin load paths", async () => {
    const missingPath = path.join(os.tmpdir(), `openclaw-missing-load-path-${Date.now()}`);
    const findings = await collectPluginLoadPathFindings({
      cfg: {
        plugins: {
          load: {
            paths: [missingPath],
          },
        },
      } satisfies OpenClawConfig,
    });

    expect(
      findings.some(
        (finding) =>
          finding.checkId === "plugins.load_paths.missing" && finding.severity === "warn",
      ),
    ).toBe(true);
  });
});
