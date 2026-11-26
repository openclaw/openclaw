import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";

const temps = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.platform === "win32").each([
  { absolute: false, mutate: false },
  { absolute: true, mutate: false },
  { absolute: false, mutate: true },
])(
  "checks every resident profile artifact (absolute=$absolute, write=$mutate)",
  ({ absolute, mutate }) => {
    const home = realpathSync(temps.make("resident-entry-probe-"));
    const { file, json, write } = fixtureFiles(home);
    const prefix = ".openclaw/git-install";
    const release = "releases/release-id/openclaw";
    const root = prefix + "/" + release;
    const verdict = {
      protocol: 1,
      verdict: "admit",
      reasons: [],
      facts: { candidateVersion: "2026.12.1", checks: [{ name: "config", status: "warn" }] },
      warnings: [{ code: "configured-plugin-path-unavailable" }],
    };
    json(root + "/package.json", {
      version: "2026.12.1",
      openclaw: { updateAdmissionProtocol: 1 },
    });
    write(root + "/managed-receipt", "original");
    write(
      root + "/dist/index.js",
      [
        'const fs = require("node:fs");',
        'if (fs.readFileSync(".openclaw-lifecycle-pending", "utf8").trimEnd() !== "pending") process.exit(3);',
        ...(mutate ? ['fs.writeFileSync("managed-receipt", "changed");'] : []),
        `console.log(JSON.stringify(${JSON.stringify(verdict)}));`,
      ].join("\n"),
    );
    symlinkSync(absolute ? file(root) : release, file(prefix + "/openclaw"), "dir");
    const reportPath = file("report.json");
    const result = spawnSync(
      resolveTestNodeExecPath(),
      [
        "scripts/e2e/lib/upgrade-survivor/update-admission-entry-probe.mjs",
        file(prefix + "/openclaw"),
        reportPath,
        "resident",
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: process.env.TMPDIR,
          OPENCLAW_QA_ALLOW_UPDATE_FIRST_HOP: "1",
          OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT:
            "/tmp/openclaw-update-first-hop-runtime/admission-missing-load-path",
          OPENCLAW_STATE_DIR: file(".openclaw"),
          OPENCLAW_CONFIG_PATH: file(".openclaw/openclaw.json"),
        },
      },
    );
    expect(existsSync(file(root + "/.openclaw-lifecycle-pending"))).toBe(false);
    if (mutate) {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Admission changed profile artifacts");
      expect(existsSync(reportPath)).toBe(false);
    } else {
      const childStderrPath = reportPath + ".stderr";
      const childStderr = existsSync(childStderrPath) ? readFileSync(childStderrPath, "utf8") : "";
      expect(result.status, result.stderr + childStderr).toBe(0);
      expect(JSON.parse(readFileSync(reportPath, "utf8"))).toMatchObject({
        pendingLifecycleMarkerPreserved: true,
        profileArtifactsPreserved: true,
        verdict,
      });
    }
  },
);
