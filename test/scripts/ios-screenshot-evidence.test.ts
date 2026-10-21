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
const ATTEMPT_MODEL = {
  owner: "openclaw",
  unit: "device XCTest invocation",
  maxAttempts: 1,
};
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

function provenance() {
  return {
    targetSha: TARGET_SHA,
    workflowSha: WORKFLOW_SHA,
    runId: "12345",
    runAttempt: 2,
    tooling: {
      xcode: "Xcode 26.6 Build version 17F113",
      fastlane: "2.236.1",
      node: "v24.16.0",
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
      fs.writeFileSync(
        path.join(result, "summary.json"),
        JSON.stringify({ result: "Passed", failedTests: 0 }),
      );
      fs.writeFileSync(
        path.join(result, "tests.json"),
        JSON.stringify({
          testNodes: [
            {
              nodeType: "UI test bundle",
              name: "OpenClawUITests",
              children: [
                {
                  nodeType: "Test Suite",
                  name: "OpenClawSnapshotUITests",
                  children: TEST_IDENTIFIERS.toReversed().map((identifier) => ({
                    nodeType: "Test Case",
                    nodeIdentifier: `${identifier.split("/").slice(1).join("/")}()`,
                    result: "Passed",
                  })),
                },
              ],
            },
          ],
        }),
      );
    }
  }
  fs.writeFileSync(
    path.join(xcresults, "capture-attempts.json"),
    JSON.stringify({ schemaVersion: 2, attempts: captureAttempts }),
  );
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
    const manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
    manifest.runAttempt = runAttempt;
    fs.writeFileSync(filePath, JSON.stringify(manifest));
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
    readXcresult: (resultPath, section) =>
      JSON.parse(fs.readFileSync(path.join(resultPath, `${section}.json`), "utf8")),
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
  const manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
  mutate(manifest);
  fs.writeFileSync(filePath, JSON.stringify(manifest));
}

function updateAllManifests(input: string, mutate: (manifest: Record<string, any>) => void) {
  for (const family of ["iphone", "ipad-13", "watch"] as const) {
    updateManifest(input, family, mutate);
  }
}

describe("iOS screenshot evidence", () => {
  it("reduces the workflow's single named artifact extraction layout", () => {
    const workflow = readCiWorkflow();
    const download = workflow.jobs["ios-screenshot-evidence"].steps.find(
      (step: WorkflowStep) => step.uses === DOWNLOAD_ARTIFACT_V8,
    ) as WorkflowStep;
    const revision = "${{ needs.preflight.outputs.checkout_revision }}";
    expect(download.with?.name).toBe(`ios-release-screenshot-capture-${revision}`);
    expect(download.with?.pattern).toBeUndefined();

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
    const manifest = JSON.parse(
      fs.readFileSync(path.join(output, "apps/ios/build/ScreenshotEvidence/manifest.json"), "utf8"),
    );
    const iphoneManifest = JSON.parse(fs.readFileSync(manifestPath(input, "iphone"), "utf8"));

    expect(manifest.attemptModel).toEqual(ATTEMPT_MODEL);
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
    const tree = JSON.parse(fs.readFileSync(testsPath, "utf8"));
    tree.testNodes[0].children[0].children.pop();
    fs.writeFileSync(testsPath, JSON.stringify(tree));

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
    const { input, output } = collected();
    updateManifest(input, "ipad-13", (manifest) => {
      manifest.targetSha = "c".repeat(40);
    });

    expect(() => reduceAll(input, output)).toThrow("cross-SHA screenshot evidence");
  });

  it.each([
    ["workflow SHA", "workflowSha", "c".repeat(40), "workflow SHA"],
    ["run id", "runId", "99999", "workflow run id"],
    ["future run attempt", "runAttempt", 3, "workflow run attempt"],
    ["invalid run attempt 0", "runAttempt", 0, "workflow run attempt"],
    ["invalid run attempt 1.5", "runAttempt", 1.5, "workflow run attempt"],
    ["Xcode version", "xcode", "Xcode 26.6 Build version forged", "xcode version"],
  ] as const)("rejects self-consistent forged %s", (_label, key, value, error) => {
    const { input, output } = collected();
    updateAllManifests(input, (manifest) => {
      if (key === "xcode") {
        manifest.tooling.xcode = value;
      } else {
        manifest[key] = value;
      }
    });

    expect(() => reduceAll(input, output)).toThrow(error);
  });

  it.each(["missing", "owner"])("rejects %s attempt model changes", (kind) => {
    const { input, output } = collected();
    updateManifest(input, "iphone", (manifest) => {
      if (kind === "missing") {
        delete manifest.attemptModel;
      } else {
        manifest.attemptModel.owner = "fastlane";
      }
    });

    expect(() => reduceAll(input, output)).toThrow("unexpected attempt model");
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
    const { input, output } = collected();
    updateManifest(input, "ipad-13", (manifest) => {
      const [final] = manifest.captureAttempts;
      final.testResult = "Failed";
      final.failedTests = 1;
    });

    expect(() => reduceAll(input, output)).toThrow("final xcresult is not passing");
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
        const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
        ledger.attempts.push({ ...ledger.attempts[0], deviceName: "Unknown" });
        fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
      }
      expect(() => collect(source)).toThrow(/combined .*union/u);
    },
  );

  it.each(["missing", "duplicate", "unexpected", "failed"] as const)(
    "rejects %s test results in a collected device manifest",
    (kind) => {
      const { input, output } = collected();
      updateManifest(input, "iphone", (manifest) => {
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
      expect(() => reduceAll(input, output)).toThrow("screenshot test result union mismatch");
    },
  );

  it("rejects unexpected files in a collected shard", () => {
    const { input, output } = collected();
    fs.writeFileSync(path.join(familyDirectory(input, "watch"), "unexpected.txt"), "unexpected");

    expect(() => reduceAll(input, output)).toThrow("shard contains unexpected evidence");
  });

  it("rejects artifact paths outside the declared family directory", () => {
    const { input, output } = collected();
    updateManifest(input, "watch", (manifest) => {
      manifest.screenshots[0].artifactPath = "../iphone/manifest.json";
    });

    expect(() => reduceAll(input, output)).toThrow("unexpected screenshot artifact path");
  });
});
