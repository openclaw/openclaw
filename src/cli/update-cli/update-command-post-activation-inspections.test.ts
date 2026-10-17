import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  renderUpdateRunReport,
  updateRunReportInputFromResult,
} from "../../infra/update-run-report.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { runPostActivationInspections } from "./update-command-post-activation-inspections.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const doctorStep = (selectors: string[] | null, cwd = "/synthetic/candidate") => ({
  name: "openclaw doctor",
  command: "doctor --fix",
  cwd,
  durationMs: 0,
  exitCode: 0,
  deferredInspectionCheckIds: selectors,
});

async function inspectFixture(
  label: string,
  script: string,
  selectors: string[],
  result: Partial<UpdateRunResult> = {},
) {
  const root = tempDirs.make(label);
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(path.join(root, "dist/index.js"), script);
  return runPostActivationInspections({
    root,
    gatewayReady: true,
    nodeRunner: process.execPath,
    result: {
      status: "ok",
      mode: "npm",
      durationMs: 0,
      steps: [doctorStep(selectors, root)],
      ...result,
    },
  });
}

it("includes nondefault inspections in the retry command after advisory findings", async () => {
  const observed = await inspectFixture(
    "doctor-advisory-retry-",
    `process.stdout.write(JSON.stringify({
      ok: false, checksRun: 1,
      findings: [{ checkId: "core/doctor/hooks-model", severity: "info", message: "Review hooks." }]
    })); process.exitCode = 1;`,
    ["core/doctor/hooks-model"],
  );
  expect(observed.status).toBe("ok");
  expect(observed.steps.at(-1)?.advisory?.message).toContain(
    "openclaw doctor --lint --all --severity-min info",
  );
});

it("passes selectors as literal arguments and reports checks the target did not run", async () => {
  const root = tempDirs.make("doctor-unrun-selectors-");
  const argvPath = path.join(root, "argv.json");
  const selector = "target:Missing Check; $(echo unused)";
  const observed = await inspectFixture(
    "doctor-literal-selectors-",
    `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ ok: false, checksRun: 0, findings: [] }));
process.exitCode = 1;
`,
    [selector],
    { mode: "git" },
  );
  expect(JSON.parse(await fs.readFile(argvPath, "utf8"))).toContain(`--only=${selector}`);
  expect(observed.status).toBe("ok");
  expect(observed.steps.at(-1)).toMatchObject({
    exitCode: 1,
    advisory: { message: expect.stringContaining("did not run every deferred inspection") },
  });
});

it("keeps the version change but flags inspections a missing post-swap module left unrun", async () => {
  // The replaced package no longer has a chunk this run expected.
  const observed = await inspectFixture(
    "doctor-missing-module-",
    `process.stderr.write("Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'dist/doctor-health-contributions-old.mjs'\\n");
process.exitCode = 13;
`,
    ["core/doctor/command-owner"],
    {
      after: { version: "2026.10.6" },
      before: { version: "2026.10.5" },
    },
  );
  expect(observed.status).toBe("ok");
  const report = renderUpdateRunReport(updateRunReportInputFromResult(observed));
  expect(report.headline).toBe(
    "✅ OpenClaw updated to 2026.10.6 (from 2026.10.5); 1 warning needs attention.",
  );
  expect(report.lines[0]).toMatch(
    /^Warning: Deferred Doctor inspections did not complete after restart \(.*ERR_MODULE_NOT_FOUND.*\)\. Run `openclaw doctor --lint --all --severity-min info`/s,
  );
});

it.each([null, "not-an-array", [" "], { length: 0 }].map((selectors) => ({ selectors })))(
  "does not revive an earlier report when the latest Doctor selectors are unusable ($selectors)",
  async ({ selectors }) => {
    // Decode a malformed wire receipt rather than constructing a valid typed step.
    const result: UpdateRunResult = JSON.parse(`{
      "status": "ok", "mode": "git", "durationMs": 0,
      "steps": ${JSON.stringify([
        doctorStep(["core/doctor/command-owner"]),
        {
          ...doctorStep(null),
          name: "post-plugin doctor",
          deferredInspectionCheckIds: selectors,
        },
      ])}
    }`);
    const observed = await runPostActivationInspections({
      root: "/synthetic/candidate",
      gatewayReady: true,
      result,
    });
    expect(observed.status).toBe("ok");
    expect(observed.steps.at(-1)).toMatchObject({
      name: "post-activation doctor inspections",
      exitCode: null,
      advisory: {
        kind: "recoverable-maintenance",
        message: expect.stringContaining("did not report usable deferred inspection selectors"),
      },
    });
  },
);

it.each(["doctor", "inline lint"])(
  "does not turn an empty deferred set from %s into an unfiltered lint pass",
  async (receiptOwner) => {
    const result: UpdateRunResult = {
      status: "ok",
      mode: "git",
      durationMs: 0,
      steps: [doctorStep(receiptOwner === "doctor" ? [] : null)],
    };
    if (receiptOwner === "inline lint") {
      result.postUpdate = {
        plugins: {
          status: "ok",
          changed: false,
          sync: {
            changed: false,
            switchedToBundled: [],
            switchedToNpm: [],
            warnings: [],
            errors: [],
          },
          npm: { changed: false, outcomes: [] },
          integrityDrifts: [],
          doctorLint: {
            name: "post-plugin-doctor-lint",
            command: "doctor --lint --all",
            cwd: "/synthetic/candidate",
            durationMs: 0,
            exitCode: 0,
            deferredInspectionCheckIds: [],
          },
        },
      };
    }
    await expect(
      runPostActivationInspections({ root: "/synthetic/candidate", gatewayReady: true, result }),
    ).resolves.toEqual(result);
  },
);
