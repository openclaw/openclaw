import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { runPostActivationInspections } from "./update-command-post-activation-inspections.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("passes selectors as literal arguments and reports checks the target did not run", async () => {
  const root = tempDirs.make("doctor-unrun-selectors-");
  const argvPath = path.join(root, "argv.json");
  const selector = "target:Missing Check; $(echo unused)";
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(
    path.join(root, "dist/index.js"),
    `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ ok: false, checksRun: 0, findings: [] }));
process.exitCode = 1;
`,
  );
  const observed = await runPostActivationInspections({
    root,
    gatewayReady: true,
    nodeRunner: process.execPath,
    result: {
      status: "ok",
      mode: "git",
      durationMs: 0,
      steps: [
        {
          name: "openclaw doctor",
          command: "doctor --fix",
          cwd: root,
          durationMs: 0,
          exitCode: 0,
          deferredInspectionCheckIds: [selector],
        },
      ],
    },
  });
  expect(JSON.parse(await fs.readFile(argvPath, "utf8"))).toContain(`--only=${selector}`);
  expect(observed.status).toBe("ok");
  expect(observed.steps.at(-1)).toMatchObject({
    exitCode: 1,
    advisory: { message: expect.stringContaining("did not run every deferred inspection") },
  });
});

it.each([null, "not-an-array", [" "], { length: 0 }].map((selectors) => ({ selectors })))(
  "does not revive an earlier report when the latest Doctor selectors are unusable ($selectors)",
  async ({ selectors }) => {
    // Decode a malformed wire receipt rather than constructing a valid typed step.
    const result: UpdateRunResult = JSON.parse(`{
      "status": "ok", "mode": "git", "durationMs": 0,
      "steps": [
        { "name": "openclaw doctor", "command": "doctor --fix",
          "cwd": "/synthetic/candidate", "durationMs": 0, "exitCode": 0,
          "deferredInspectionCheckIds": ["core/doctor/command-owner"] },
        { "name": "post-plugin doctor", "command": "doctor --fix",
          "cwd": "/synthetic/candidate", "durationMs": 0, "exitCode": 0,
          "deferredInspectionCheckIds": ${JSON.stringify(selectors)} }
      ]
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

it("does not turn a reported empty deferred set into an unfiltered lint pass", async () => {
  const result: UpdateRunResult = {
    status: "ok",
    mode: "git",
    durationMs: 0,
    steps: [
      {
        name: "openclaw doctor",
        command: "doctor --fix",
        cwd: "/synthetic/candidate",
        durationMs: 0,
        exitCode: 0,
        deferredInspectionCheckIds: [],
      },
    ],
  };
  await expect(
    runPostActivationInspections({ root: "/synthetic/candidate", gatewayReady: true, result }),
  ).resolves.toEqual(result);
});
