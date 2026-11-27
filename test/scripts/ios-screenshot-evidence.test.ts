import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectIosScreenshotEvidence,
  reduceIosScreenshotEvidence,
} from "../../scripts/ios-screenshot-evidence.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  DOWNLOAD_ARTIFACT_V8,
  readCiWorkflow,
  testNodeExecPath,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const TARGET_SHA = "a".repeat(40);
const WORKFLOW_SHA = "b".repeat(40);
const PNG = Buffer.from("89504e470d0a1a0a66697874757265", "hex");
const SCREENSHOTS = [
  "01-control-connected",
  "02-chat-connected",
  "03-agent-connected",
  "04-settings-connected",
];
const TEST_IDENTIFIERS = [
  "OpenClawUITests/OpenClawSnapshotUITests/testReleaseControlScreenshot",
  "OpenClawUITests/OpenClawSnapshotUITests/testReleaseChatScreenshot",
  "OpenClawUITests/OpenClawSnapshotUITests/testReleaseAgentScreenshot",
  "OpenClawUITests/OpenClawSnapshotUITests/testReleaseSettingsScreenshot",
];
type Family = "iphone" | "ipad-13" | "watch";
const DEVICES = {
  iphone: "iPhone 17 Pro Max",
  "ipad-13": "iPad Pro 13-inch (M5)",
  watch: "Apple Watch Ultra 3 (49mm)",
};
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value));

function provenance() {
  return {
    targetSha: TARGET_SHA,
    workflowSha: WORKFLOW_SHA,
    runId: "12345",
    runAttempt: 2,
    tooling: {
      xcode: "Xcode 26.6 Build version 17F113",
      fastlane: "2.236.1",
      node: "v24.22.1",
    },
  };
}

function writeCombinedSource(root: string, selectedFamily: Family = "iphone", retry = false) {
  const screenshots = path.join(root, "screenshots");
  const xcresults = path.join(root, "xcresults");
  fs.mkdirSync(screenshots, { recursive: true });
  fs.mkdirSync(xcresults, { recursive: true });
  const captureAttempts = [];
  for (const family of ["iphone", "ipad-13", "watch"] as const) {
    const device = DEVICES[family];
    const names = family === "watch" ? ["01-now-face"] : SCREENSHOTS;
    for (const name of names) {
      fs.writeFileSync(path.join(screenshots, `${device}-${name}.png`), PNG);
    }
    if (family === "watch") {
      continue;
    }
    const retried = family === selectedFamily && retry;
    for (const attempt of retried ? [1, 2] : [1]) {
      captureAttempts.push({
        deviceName: device,
        attempt,
        captureOutcome: retried && attempt === 1 ? "failed" : "succeeded",
      });
      const result = path.join(xcresults, `${device}-attempt-${attempt}.xcresult`);
      fs.mkdirSync(result, { recursive: true });
      writeJson(path.join(result, "summary.json"), { result: "Passed", failedTests: 0 });
      writeJson(path.join(result, "tests.json"), {
        testNodes: [
          {
            nodeType: "UI test bundle",
            name: "OpenClawUITests",
            children: TEST_IDENTIFIERS.toReversed().map((identifier) => ({
              nodeType: "Test Case",
              nodeIdentifier: `${identifier.split("/").slice(1).join("/")}()`,
              result: "Passed",
            })),
          },
        ],
      });
    }
  }
  writeJson(path.join(xcresults, "capture-attempts.json"), {
    schemaVersion: 2,
    attempts: captureAttempts,
  });
  return { device: DEVICES[selectedFamily], screenshots, xcresults };
}

function containerName() {
  return `ios-release-screenshot-capture-${TARGET_SHA}`;
}

function familyDirectory(input: string, family: Family) {
  return path.join(input, containerName(), family);
}

function manifestPath(input: string, family: Family) {
  return path.join(familyDirectory(input, family), "manifest.json");
}

function collectAll(root: string, runAttempts: Partial<Record<Family, number>> = {}) {
  const output = path.join(root, "collected");
  const source = writeCombinedSource(root);
  collect(source, path.join(output, containerName()));
  for (const [family, runAttempt] of Object.entries(runAttempts)) {
    const filePath = manifestPath(output, family as Family);
    const manifest = readJson(filePath);
    manifest.runAttempt = runAttempt;
    writeJson(filePath, manifest);
  }
  return output;
}

function collect(
  source: ReturnType<typeof writeCombinedSource>,
  outputDirectory = path.join(path.dirname(source.screenshots), "collected"),
) {
  return collectIosScreenshotEvidence({
    screenshotDirectory: source.screenshots,
    xcresultDirectory: source.xcresults,
    outputDirectory,
    provenance: provenance(),
    readXcresult: (resultPath, section) => readJson(path.join(resultPath, `${section}.json`)),
  });
}

function collected(runAttempts: Partial<Record<Family, number>> = {}) {
  const root = tempDirs.make("ios-screenshot-evidence-");
  return {
    root,
    input: collectAll(root, runAttempts),
    output: path.join(root, "reduced"),
  };
}

function reduceAll(input: string, outputRoot: string, expected = provenance()) {
  return reduceIosScreenshotEvidence({
    inputDirectory: input,
    outputRoot,
    expectedProvenance: expected,
  });
}

function expectOutputCounts(output: string) {
  expect(fs.readdirSync(path.join(output, "apps/ios/fastlane/screenshots/en-US"))).toHaveLength(9);
  expect(fs.readdirSync(path.join(output, "apps/ios/build/SnapshotTestResults"))).toHaveLength(2);
}

function updateManifest(
  input: string,
  family: Family,
  mutate: (manifest: Record<string, any>) => void,
) {
  const filePath = manifestPath(input, family);
  const manifest = readJson(filePath);
  mutate(manifest);
  writeJson(filePath, manifest);
}

function rejectsManifest(
  family: Family | "all",
  error: string,
  mutate: Parameters<typeof updateManifest>[2],
) {
  const { input, output } = collected();
  const families: Family[] = family === "all" ? ["iphone", "ipad-13", "watch"] : [family];
  for (const selected of families) {
    updateManifest(input, selected, mutate);
  }
  expect(() => reduceAll(input, output)).toThrow(error);
}

describe("iOS screenshot evidence", () => {
  it.skipIf(process.platform === "win32")(
    "runs the production reducer CLI with only its three-file import closure",
    () => {
      const workflow = readCiWorkflow();
      const reducer = workflow.jobs["ios-screenshot-evidence"].steps.find(
        (step: WorkflowStep) => step.id === "reduce_screenshot_evidence",
      ) as WorkflowStep;
      const { root, input } = collected();
      const workspace = path.join(root, "workspace");
      for (const file of [
        "scripts/ios-screenshot-evidence.mjs",
        "scripts/lib/direct-run.mjs",
        "scripts/lib/ios-test-results.mjs",
      ]) {
        const destination = path.join(workspace, ".ci-harness", file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(file, destination);
      }
      const bin = path.join(root, "bin");
      fs.mkdirSync(bin);
      fs.symlinkSync(testNodeExecPath, path.join(bin, "node"));
      const forbiddenLog = path.join(root, "package-manager.log");
      for (const command of ["pnpm", "npm", "npx", "corepack"]) {
        fs.writeFileSync(
          path.join(bin, command),
          '#!/bin/sh\necho invoked >> "$FORBIDDEN_LOG"\nexit 97\n',
          { mode: 0o755 },
        );
      }
      const nodeVersion = spawnSync(testNodeExecPath, ["--version"], {
        encoding: "utf8",
      });
      expect(nodeVersion.status, nodeVersion.stderr).toBe(0);
      const expected = {
        ...provenance(),
        tooling: { ...provenance().tooling, node: nodeVersion.stdout.trim() },
      };
      for (const family of ["iphone", "ipad-13", "watch"] as const) {
        updateManifest(input, family, (manifest) => {
          manifest.tooling.node = expected.tooling.node;
        });
      }
      const reference = path.join(root, "reference");
      reduceAll(input, reference, expected);
      const received = path.join(workspace, "apps/ios/build/ScreenshotEvidenceInputs");
      const run = () =>
        spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", reducer.run ?? ""], {
          cwd: workspace,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:/usr/bin:/bin`,
            NODE_OPTIONS: "",
            NODE_PATH: "",
            FORBIDDEN_LOG: forbiddenLog,
            RUN_ID: expected.runId,
            RUN_ATTEMPT: String(expected.runAttempt),
            TARGET_SHA: expected.targetSha,
            WORKFLOW_SHA: expected.workflowSha,
            IOS_SCREENSHOT_XCODE_VERSION: expected.tooling.xcode,
            IOS_SCREENSHOT_FASTLANE_VERSION: expected.tooling.fastlane,
          },
        });
      fs.cpSync(input, received, { recursive: true });
      const result = run();
      expect(result.status, result.stderr).toBe(0);
      expectOutputCounts(workspace);
      const manifest = "apps/ios/build/ScreenshotEvidence/manifest.json";
      expect(fs.readFileSync(path.join(workspace, manifest), "utf8")).toBe(
        fs.readFileSync(path.join(reference, manifest), "utf8"),
      );
      for (const failure of ["digest", "future", "mixed"] as const) {
        fs.rmSync(received, { recursive: true });
        fs.cpSync(input, received, { recursive: true });
        if (failure === "digest") {
          const png = path.join(
            familyDirectory(received, "watch"),
            "screenshots/Apple Watch Ultra 3 (49mm)-01-now-face.png",
          );
          fs.appendFileSync(png, "changed");
        } else {
          updateManifest(received, "watch", (item) => {
            item.runAttempt = failure === "future" ? expected.runAttempt + 1 : 1;
          });
        }
        const rejected = run();
        expect(rejected.status, `${failure}: ${rejected.stderr}`).toBe(1);
        expect(rejected.stderr).toContain(
          failure === "digest"
            ? "digest mismatch"
            : failure === "future"
              ? "workflow run attempt"
              : "mixes evidence from different workflow run attempts",
        );
      }
      expect(fs.existsSync(forbiddenLog)).toBe(false);
      expect(fs.existsSync(path.join(workspace, "node_modules"))).toBe(false);
    },
  );

  it("reduces the workflow's single named artifact extraction layout", () => {
    const workflow = readCiWorkflow();
    const download = workflow.jobs["ios-screenshot-evidence"].steps.find(
      (step: WorkflowStep) => step.uses === DOWNLOAD_ARTIFACT_V8,
    ) as WorkflowStep;
    const revision = "${{ needs.preflight.outputs.checkout_revision }}";
    expect(download.with?.name).toBe(`ios-release-screenshot-capture-${revision}`);

    const { root, input, output } = collected();
    const workspace = path.join(root, "workspace");
    const receiverPath = path.join(
      workspace,
      String(download.with?.path).replace(revision, TARGET_SHA),
    );
    // download-artifact v8 extracts a single match directly into the requested path.
    fs.cpSync(path.join(input, containerName()), receiverPath, { recursive: true });
    reduceAll(path.join(workspace, "apps/ios/build/ScreenshotEvidenceInputs"), output);

    expectOutputCounts(output);
  });

  it("reduces successful device captures across workflow retries", () => {
    const reducerAttempt = 4,
      captureAttempt = 3;
    const { input, output } = collected({
      iphone: captureAttempt,
      "ipad-13": captureAttempt,
      watch: captureAttempt,
    });
    reduceAll(input, output, { ...provenance(), runAttempt: reducerAttempt });
    const manifest = readJson(path.join(output, "apps/ios/build/ScreenshotEvidence/manifest.json"));
    const iphoneManifest = readJson(manifestPath(input, "iphone"));

    expect(manifest).toMatchObject({
      targetSha: TARGET_SHA,
      runAttempt: reducerAttempt,
      families: [
        { family: "ipad-13", runAttempt: captureAttempt },
        { family: "iphone", runAttempt: captureAttempt },
        { family: "watch", runAttempt: captureAttempt },
      ],
    });
    expect(iphoneManifest.captureAttempts).toHaveLength(1);
    for (const capture of iphoneManifest.captureAttempts) {
      expect(capture).toMatchObject({
        attempt: 1,
        captureOutcome: "succeeded",
        testResult: "Passed",
        failedTests: 0,
        tests: TEST_IDENTIFIERS.map((testIdentifier) => ({ testIdentifier, testResult: "Passed" })),
      });
    }
    expectOutputCounts(output);
  });

  it("rejects a passing retry after a failed capture", () => {
    const root = tempDirs.make("ios-screenshot-retry-");
    const source = writeCombinedSource(root, "iphone", true);

    expect(() => collect(source)).toThrow("expected exactly one OpenClaw capture attempt");
  });

  it("requires the successful capture to have a passing xcresult", () => {
    const root = tempDirs.make("ios-screenshot-missing-xcresult-");
    const source = writeCombinedSource(root, "iphone");
    fs.rmSync(path.join(source.xcresults, `${source.device}-attempt-1.xcresult`), {
      recursive: true,
    });

    expect(() => collect(source)).toThrow("is missing for the successful capture attempt");
  });

  it("requires all four native test results even when the summary passed", () => {
    const root = tempDirs.make("ios-screenshot-missing-test-");
    const source = writeCombinedSource(root);
    const testsPath = path.join(
      source.xcresults,
      `${source.device}-attempt-1.xcresult`,
      "tests.json",
    );
    const tree = readJson(testsPath);
    tree.testNodes[0].children.pop();
    writeJson(testsPath, tree);

    expect(() => collect(source)).toThrow("test-identity-or-result");
  });

  it.each([
    ["renamed", "", `../ios-release-screenshot-capture-renamed-${TARGET_SHA}`],
    ["renamed Watch family", "watch", "unknown-watch"],
  ])("rejects %s artifact container topology", (_label, from, to) => {
    const { input, output } = collected();
    const container = path.join(input, containerName());
    fs.renameSync(path.join(container, from), path.join(container, to));

    expect(() => reduceAll(input, output)).toThrow(/topology mismatch/u);
  });

  it("rejects one capture job's families from different attempts", () => {
    const { input, output } = collected({ watch: 1 });

    expect(() => reduceAll(input, output)).toThrow(
      `${containerName()} mixes evidence from different workflow run attempts`,
    );
  });

  it("rejects cross-SHA shard evidence", () => {
    rejectsManifest("ipad-13", "cross-SHA screenshot evidence", (manifest) => {
      manifest.targetSha = "c".repeat(40);
    });
  });

  it.each([
    ["workflow SHA", "workflowSha", "c".repeat(40), "workflow SHA"],
    ["run id", "runId", "99999", "workflow run id"],
    ["future run attempt", "runAttempt", 3, "workflow run attempt"],
    ["invalid run attempt 0", "runAttempt", 0, "workflow run attempt"],
    ["invalid run attempt 1.5", "runAttempt", 1.5, "workflow run attempt"],
    ["Xcode version", "xcode", "Xcode 26.6 Build version forged", "xcode version"],
  ] as const)("rejects self-consistent forged %s", (_label, key, value, error) => {
    rejectsManifest("all", error, (manifest) => {
      if (key === "xcode") {
        manifest.tooling.xcode = value;
      } else {
        manifest[key] = value;
      }
    });
  });

  it.each(["missing", "owner"])("rejects %s attempt model changes", (kind) => {
    rejectsManifest("iphone", "unexpected attempt model", (manifest) => {
      if (kind === "missing") {
        delete manifest.attemptModel;
      } else {
        manifest.attemptModel.owner = "fastlane";
      }
    });
  });

  it.each([
    ["PNG", "watch", "screenshots/Apple Watch Ultra 3 (49mm)-01-now-face.png", "screenshot"],
    [
      "xcresult",
      "iphone",
      "xcresults/iPhone 17 Pro Max-attempt-1.xcresult/summary.json",
      "xcresult",
    ],
  ] as const)("rejects changed %s bytes after collection", (_kind, family, file, error) => {
    const { input, output } = collected();
    fs.appendFileSync(path.join(familyDirectory(input, family), file), "changed");
    expect(() => reduceAll(input, output)).toThrow(`${error} digest mismatch`);
  });

  it("rejects a non-passing final capture attempt", () => {
    rejectsManifest("ipad-13", "final xcresult is not passing", (manifest) => {
      const [final] = manifest.captureAttempts;
      final.testResult = "Failed";
      final.failedTests = 1;
    });
  });

  it("rejects a passing replacement added to an already collected failed capture", () => {
    const { input, output } = collected();
    updateManifest(input, "iphone", (manifest) => {
      const [capture] = manifest.captureAttempts;
      const replacement = {
        ...capture,
        attempt: 2,
        artifactPath: capture.artifactPath.replace("attempt-1", "attempt-2"),
        canonicalPath: capture.canonicalPath.replace("attempt-1", "attempt-2"),
      };
      capture.captureOutcome = "failed";
      fs.cpSync(
        path.join(familyDirectory(input, "iphone"), capture.artifactPath),
        path.join(familyDirectory(input, "iphone"), replacement.artifactPath),
        { recursive: true },
      );
      manifest.captureAttempts.push(replacement);
    });

    expect(() => reduceAll(input, output)).toThrow("capture attempt union mismatch");
  });

  it("rejects an invalid PNG signature before collection", () => {
    const root = tempDirs.make("ios-screenshot-signature-");
    const source = writeCombinedSource(root, "watch");
    fs.writeFileSync(
      path.join(source.screenshots, `${source.device}-01-now-face.png`),
      "not a png",
    );

    expect(() => collect(source)).toThrow("invalid PNG signature");
  });

  it("rejects unexpected screenshots in a device shard", () => {
    const root = tempDirs.make("ios-screenshot-unexpected-");
    const source = writeCombinedSource(root, "iphone");
    fs.writeFileSync(path.join(source.screenshots, `${source.device}-99-unexpected.png`), PNG);

    expect(() => collect(source)).toThrow("PNG union mismatch");
  });

  it.each(["PNG", "xcresult", "ledger"] as const)(
    "rejects an unrecognized device in the combined %s source",
    (kind) => {
      const root = tempDirs.make("ios-screenshot-unknown-device-");
      const source = writeCombinedSource(root);
      if (kind === "PNG") {
        fs.writeFileSync(path.join(source.screenshots, "Unknown-01-control-connected.png"), PNG);
      } else if (kind === "xcresult") {
        fs.mkdirSync(path.join(source.xcresults, "Unknown-attempt-1.xcresult"));
      } else {
        const ledgerPath = path.join(source.xcresults, "capture-attempts.json");
        const ledger = readJson(ledgerPath);
        ledger.attempts.push({ ...ledger.attempts[0], deviceName: "Unknown" });
        writeJson(ledgerPath, ledger);
      }
      expect(() => collect(source)).toThrow(/combined .*union/u);
    },
  );

  it.each(["missing", "duplicate", "unexpected", "failed"] as const)(
    "rejects %s test results in a collected device manifest",
    (kind) => {
      rejectsManifest("iphone", "screenshot test result union mismatch", (manifest) => {
        const tests = manifest.captureAttempts[0].tests;
        if (kind === "missing") {
          tests.pop();
        } else if (kind === "duplicate") {
          tests[1] = tests[0];
        } else if (kind === "unexpected") {
          tests[0].testIdentifier = "OpenClawUITests/OpenClawSnapshotUITests/testOther";
        } else {
          tests[0].testResult = "Failed";
        }
      });
    },
  );

  it("rejects unexpected files in a collected shard", () => {
    const { input, output } = collected();
    fs.writeFileSync(path.join(familyDirectory(input, "watch"), "unexpected.txt"), "unexpected");

    expect(() => reduceAll(input, output)).toThrow("shard contains unexpected evidence");
  });

  it("rejects artifact paths outside the declared family directory", () => {
    rejectsManifest("watch", "unexpected screenshot artifact path", (manifest) => {
      manifest.screenshots[0].artifactPath = "../iphone/manifest.json";
    });
  });
});
