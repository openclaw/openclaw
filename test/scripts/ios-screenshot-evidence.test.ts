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
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("fixture"),
]);
const SCREENSHOTS = [
  "01-control-connected",
  "02-chat-connected",
  "03-agent-connected",
  "04-settings-connected",
];
const ATTEMPT_MODEL = {
  owner: "openclaw",
  unit: "capture_ios_screenshots invocation",
  maxAttempts: 1,
  fastlaneInternalRetries: "workflow-log",
};
type Family = "iphone" | "ipad-13" | "watch";

function provenance(targetSha = TARGET_SHA) {
  return {
    targetSha,
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

function writeCombinedSource(
  root: string,
  selectedFamily: Family = "iphone",
  options: {
    retry?: string;
    retryTestResult?: "fail" | "pass";
    retryWithoutXcresult?: boolean;
  } = {},
) {
  const screenshots = path.join(root, "screenshots");
  const xcresults = path.join(root, "xcresults");
  fs.mkdirSync(screenshots, { recursive: true });
  fs.mkdirSync(xcresults, { recursive: true });
  const captureAttempts = [];
  let selectedDevice = "";
  for (const family of ["iphone", "ipad-13", "watch"] as const) {
    const device =
      family === "iphone"
        ? "iPhone 17 Pro Max"
        : family === "ipad-13"
          ? "iPad Pro 13-inch (M5)"
          : "Apple Watch Ultra 3 (49mm)";
    if (family === selectedFamily) {
      selectedDevice = device;
    }
    const names = family === "watch" ? ["01-now-face"] : SCREENSHOTS;
    for (const name of names) {
      fs.writeFileSync(path.join(screenshots, `${device}-${name}.png`), PNG);
      if (family !== "watch") {
        const retried = family === selectedFamily && options.retry === name;
        captureAttempts.push({
          deviceName: device,
          screenshotName: name,
          attempt: 1,
          captureOutcome: retried ? "failed" : "succeeded",
        });
        if (!(retried && options.retryWithoutXcresult)) {
          const attemptOne = path.join(xcresults, `${device}-${name}-attempt-1.xcresult`);
          fs.mkdirSync(attemptOne, { recursive: true });
          fs.writeFileSync(
            path.join(attemptOne, "summary.txt"),
            retried ? (options.retryTestResult ?? "pass") : "pass",
          );
        }
        if (retried) {
          captureAttempts.push({
            deviceName: device,
            screenshotName: name,
            attempt: 2,
            captureOutcome: "succeeded",
          });
          const attemptTwo = path.join(xcresults, `${device}-${name}-attempt-2.xcresult`);
          fs.mkdirSync(attemptTwo, { recursive: true });
          fs.writeFileSync(path.join(attemptTwo, "summary.txt"), "pass");
        }
      }
    }
  }
  fs.writeFileSync(
    path.join(xcresults, "capture-attempts.json"),
    JSON.stringify({ schemaVersion: 1, attempts: captureAttempts }),
  );
  return { device: selectedDevice, screenshots, xcresults };
}

function containerName(targetSha = TARGET_SHA) {
  return `ios-release-screenshot-capture-${targetSha}`;
}

function familyDirectory(input: string, family: Family, targetSha = TARGET_SHA) {
  return path.join(input, containerName(targetSha), family);
}

function manifestPath(input: string, family: Family, targetSha = TARGET_SHA) {
  return path.join(familyDirectory(input, family, targetSha), "manifest.json");
}

function collectAll(
  root: string,
  targetSha = TARGET_SHA,
  runAttempts: Partial<Record<Family, number>> = {},
) {
  const output = path.join(root, "collected");
  const source = writeCombinedSource(root);
  collectIosScreenshotEvidence({
    screenshotDirectory: source.screenshots,
    xcresultDirectory: source.xcresults,
    outputDirectory: path.join(output, containerName(targetSha)),
    provenance: provenance(targetSha),
    readXcresultSummary: (resultPath) => {
      const result = fs.readFileSync(path.join(resultPath, "summary.txt"), "utf8");
      return result === "pass"
        ? { testResult: "Passed", failedTests: 0 }
        : { testResult: "Failed", failedTests: 1 };
    },
  });
  for (const [family, runAttempt] of Object.entries(runAttempts)) {
    const filePath = manifestPath(output, family as Family, targetSha);
    const manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
    manifest.runAttempt = runAttempt;
    fs.writeFileSync(filePath, JSON.stringify(manifest));
  }
  return output;
}

function reduceAll(input: string, outputRoot: string, expected = provenance()) {
  return reduceIosScreenshotEvidence({
    inputDirectory: input,
    outputRoot,
    expectedProvenance: expected,
  });
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

    const root = tempDirs.make("ios-screenshot-receiver-");
    const input = collectAll(root);
    const workspace = path.join(root, "workspace");
    const receiverPath = path.join(
      workspace,
      String(download.with?.path).replace(revision, TARGET_SHA),
    );
    // download-artifact v8 extracts a single match directly into the requested path.
    fs.cpSync(path.join(input, containerName()), receiverPath, { recursive: true });
    const output = path.join(root, "reduced");
    reduceAll(path.join(workspace, "apps/ios/build/ScreenshotEvidenceInputs"), output);

    expect(fs.readdirSync(path.join(output, "apps/ios/fastlane/screenshots/en-US"))).toHaveLength(
      9,
    );
    expect(fs.readdirSync(path.join(output, "apps/ios/build/SnapshotTestResults"))).toHaveLength(8);
  });

  it.each([{ reducerAttempt: 4, captureAttempt: 3 }])(
    "reduces successful device captures across workflow retries: %j",
    ({ reducerAttempt, captureAttempt }) => {
      const root = tempDirs.make("ios-screenshot-evidence-");
      const input = collectAll(root, TARGET_SHA, {
        iphone: captureAttempt,
        "ipad-13": captureAttempt,
        watch: captureAttempt,
      });
      const output = path.join(root, "reduced");

      reduceAll(input, output, { ...provenance(), runAttempt: reducerAttempt });
      const manifest = JSON.parse(
        fs.readFileSync(
          path.join(output, "apps/ios/build/ScreenshotEvidence/manifest.json"),
          "utf8",
        ),
      );
      const iphoneManifest = JSON.parse(fs.readFileSync(manifestPath(input, "iphone"), "utf8"));

      expect(manifest.targetSha).toBe(TARGET_SHA);
      expect(manifest.attemptModel).toEqual(ATTEMPT_MODEL);
      expect(manifest).toMatchObject({
        runAttempt: reducerAttempt,
        families: [
          { family: "ipad-13", runAttempt: captureAttempt },
          { family: "iphone", runAttempt: captureAttempt },
          { family: "watch", runAttempt: captureAttempt },
        ],
      });
      expect(iphoneManifest.captureAttempts).toHaveLength(4);
      for (const capture of iphoneManifest.captureAttempts) {
        expect(capture).toMatchObject({
          attempt: 1,
          captureOutcome: "succeeded",
          testResult: "Passed",
          failedTests: 0,
        });
      }
      expect(fs.readdirSync(path.join(output, "apps/ios/fastlane/screenshots/en-US"))).toHaveLength(
        9,
      );
      expect(fs.readdirSync(path.join(output, "apps/ios/build/SnapshotTestResults"))).toHaveLength(
        8,
      );
    },
  );

  it.each([{ retryTestResult: "pass" as const, retryWithoutXcresult: false }])(
    "rejects a passing retry after a failed capture: %j",
    (options) => {
      const root = tempDirs.make("ios-screenshot-retry-");
      const source = writeCombinedSource(root, "iphone", {
        retry: "02-chat-connected",
        ...options,
      });

      expect(() =>
        collectIosScreenshotEvidence({
          screenshotDirectory: source.screenshots,
          xcresultDirectory: source.xcresults,
          outputDirectory: path.join(root, "collected"),
          provenance: provenance(),
          readXcresultSummary: (resultPath) =>
            fs.readFileSync(path.join(resultPath, "summary.txt"), "utf8") === "pass"
              ? { testResult: "Passed", failedTests: 0 }
              : { testResult: "Failed", failedTests: 1 },
        }),
      ).toThrow("expected exactly one OpenClaw capture attempt");
    },
  );

  it("requires the successful capture to have a passing xcresult", () => {
    const root = tempDirs.make("ios-screenshot-missing-xcresult-");
    const source = writeCombinedSource(root, "iphone");
    fs.rmSync(
      path.join(source.xcresults, `${source.device}-02-chat-connected-attempt-1.xcresult`),
      { recursive: true },
    );

    expect(() =>
      collectIosScreenshotEvidence({
        screenshotDirectory: source.screenshots,
        xcresultDirectory: source.xcresults,
        outputDirectory: path.join(root, "collected"),
        provenance: provenance(),
        readXcresultSummary: () => ({ testResult: "Passed", failedTests: 0 }),
      }),
    ).toThrow("is missing for the successful capture attempt");
  });

  it.each([
    {
      label: "renamed",
      mutate: (input: string) =>
        fs.renameSync(
          path.join(input, containerName()),
          path.join(input, `ios-release-screenshot-capture-renamed-${TARGET_SHA}`),
        ),
    },
    {
      label: "renamed Watch family",
      mutate: (input: string) =>
        fs.renameSync(
          familyDirectory(input, "watch"),
          path.join(input, containerName(), "unknown-watch"),
        ),
    },
  ])("rejects $label artifact container topology", ({ mutate }) => {
    const root = tempDirs.make("ios-screenshot-topology-");
    const input = collectAll(root);
    mutate(input);

    expect(() => reduceAll(input, path.join(root, "reduced"))).toThrow(/topology mismatch/u);
  });

  it("rejects one capture job's families from different attempts", () => {
    const root = tempDirs.make("ios-screenshot-mixed-attempt-");
    const input = collectAll(root, TARGET_SHA, { watch: 1 });

    expect(() => reduceAll(input, path.join(root, "reduced"))).toThrow(
      `${containerName()} mixes evidence from different workflow run attempts`,
    );
  });

  it("rejects cross-SHA shard evidence", () => {
    const root = tempDirs.make("ios-screenshot-cross-sha-");
    const input = collectAll(root);
    updateManifest(input, "ipad-13", (manifest) => {
      manifest.targetSha = "c".repeat(40);
    });

    expect(() => reduceAll(input, path.join(root, "reduced"))).toThrow(
      "cross-SHA screenshot evidence",
    );
  });

  it.each([
    {
      label: "workflow SHA",
      mutate: (manifest: Record<string, any>) => {
        manifest.workflowSha = "c".repeat(40);
      },
      error: "workflow SHA",
    },
    {
      label: "run id",
      mutate: (manifest: Record<string, any>) => {
        manifest.runId = "99999";
      },
      error: "workflow run id",
    },
    {
      label: "future run attempt",
      mutate: (manifest: Record<string, any>) => {
        manifest.runAttempt = 3;
      },
      error: "workflow run attempt",
    },
    ...[0, 1.5].map((runAttempt) => ({
      label: `invalid run attempt ${JSON.stringify(runAttempt)}`,
      mutate: (manifest: Record<string, unknown>) => {
        manifest.runAttempt = runAttempt;
      },
      error: "workflow run attempt",
    })),
    {
      label: "Xcode version",
      mutate: (manifest: Record<string, any>) => {
        manifest.tooling.xcode = "Xcode 26.6 Build version forged";
      },
      error: "xcode version",
    },
  ])("rejects self-consistent forged $label", ({ mutate, error }) => {
    const root = tempDirs.make("ios-screenshot-forged-provenance-");
    const input = collectAll(root);
    updateAllManifests(input, mutate);

    expect(() => reduceAll(input, path.join(root, "reduced"))).toThrow(error);
  });

  it.each([
    {
      label: "missing",
      mutate: (manifest: Record<string, any>) => {
        delete manifest.attemptModel;
      },
    },
    {
      label: "owner",
      mutate: (manifest: Record<string, any>) => {
        manifest.attemptModel.owner = "fastlane";
      },
    },
  ])("rejects $label attempt model changes", ({ mutate }) => {
    const root = tempDirs.make("ios-screenshot-attempt-model-");
    const input = collectAll(root);
    updateManifest(input, "iphone", mutate);

    expect(() => reduceAll(input, path.join(root, "reduced"))).toThrow("unexpected attempt model");
  });

  it("rejects changed PNG bytes after collection", () => {
    const root = tempDirs.make("ios-screenshot-digest-");
    const input = collectAll(root);
    const screenshot = path.join(
      familyDirectory(input, "watch"),
      "screenshots",
      "Apple Watch Ultra 3 (49mm)-01-now-face.png",
    );
    fs.appendFileSync(screenshot, "changed");

    expect(() => reduceAll(input, path.join(root, "reduced"))).toThrow(
      "screenshot digest mismatch",
    );
  });

  it("rejects changed xcresult bytes after collection", () => {
    const root = tempDirs.make("ios-screenshot-xcresult-digest-");
    const input = collectAll(root);
    fs.appendFileSync(
      path.join(
        familyDirectory(input, "iphone"),
        "xcresults",
        "iPhone 17 Pro Max-01-control-connected-attempt-1.xcresult",
        "summary.txt",
      ),
      "changed",
    );

    expect(() => reduceAll(input, path.join(root, "reduced"))).toThrow("xcresult digest mismatch");
  });

  it("rejects a non-passing final capture attempt", () => {
    const root = tempDirs.make("ios-screenshot-final-failure-");
    const input = collectAll(root);
    updateManifest(input, "ipad-13", (manifest) => {
      const final = manifest.captureAttempts.find(
        (entry: { screenshotName: string }) => entry.screenshotName === "01-control-connected",
      );
      final.testResult = "Failed";
      final.failedTests = 1;
    });

    expect(() => reduceAll(input, path.join(root, "reduced"))).toThrow(
      "final xcresult is not passing",
    );
  });

  it("rejects a passing replacement added to an already collected failed capture", () => {
    const root = tempDirs.make("ios-screenshot-replacement-");
    const input = collectAll(root);
    updateManifest(input, "iphone", (manifest) => {
      const capture = manifest.captureAttempts.find(
        (entry: { screenshotName: string }) => entry.screenshotName === "02-chat-connected",
      );
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

    expect(() => reduceAll(input, path.join(root, "reduced"))).toThrow(
      "capture attempt union mismatch",
    );
  });

  it("rejects an invalid PNG signature before collection", () => {
    const root = tempDirs.make("ios-screenshot-signature-");
    const source = writeCombinedSource(root, "watch");
    fs.writeFileSync(
      path.join(source.screenshots, `${source.device}-01-now-face.png`),
      "not a png",
    );

    expect(() =>
      collectIosScreenshotEvidence({
        screenshotDirectory: source.screenshots,
        xcresultDirectory: source.xcresults,
        outputDirectory: path.join(root, "collected"),
        provenance: provenance(),
        readXcresultSummary: () => ({ testResult: "Passed", failedTests: 0 }),
      }),
    ).toThrow("invalid PNG signature");
  });

  it("rejects unexpected screenshots in a device shard", () => {
    const root = tempDirs.make("ios-screenshot-unexpected-");
    const source = writeCombinedSource(root, "iphone");
    fs.writeFileSync(path.join(source.screenshots, `${source.device}-99-unexpected.png`), PNG);

    expect(() =>
      collectIosScreenshotEvidence({
        screenshotDirectory: source.screenshots,
        xcresultDirectory: source.xcresults,
        outputDirectory: path.join(root, "collected"),
        provenance: provenance(),
        readXcresultSummary: () => ({ testResult: "Passed", failedTests: 0 }),
      }),
    ).toThrow("PNG union mismatch");
  });

  it.each(["PNG", "xcresult", "ledger"] as const)(
    "rejects an unrecognized device in the combined %s source",
    (kind) => {
      const root = tempDirs.make("ios-screenshot-unknown-device-");
      const source = writeCombinedSource(root);
      if (kind === "PNG") {
        fs.writeFileSync(path.join(source.screenshots, "Unknown-01-control-connected.png"), PNG);
      } else if (kind === "xcresult") {
        fs.mkdirSync(
          path.join(source.xcresults, "Unknown-01-control-connected-attempt-1.xcresult"),
        );
      } else {
        const ledgerPath = path.join(source.xcresults, "capture-attempts.json");
        const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
        ledger.attempts.push({ ...ledger.attempts[0], deviceName: "Unknown" });
        fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
      }
      expect(() =>
        collectIosScreenshotEvidence({
          screenshotDirectory: source.screenshots,
          xcresultDirectory: source.xcresults,
          outputDirectory: path.join(root, "collected"),
          provenance: provenance(),
          readXcresultSummary: () => ({ testResult: "Passed", failedTests: 0 }),
        }),
      ).toThrow(/combined .*union/u);
    },
  );

  it("rejects unexpected capture attempt entries in a shard manifest", () => {
    const root = tempDirs.make("ios-screenshot-unexpected-xcresult-");
    const input = collectAll(root);
    updateManifest(input, "iphone", (manifest) => {
      manifest.captureAttempts.push({
        ...manifest.captureAttempts[0],
        screenshotName: "99-unexpected",
      });
    });

    expect(() => reduceAll(input, path.join(root, "reduced"))).toThrow(
      "capture attempt union contains an unexpected screenshot",
    );
  });

  it("rejects unexpected files in a collected shard", () => {
    const root = tempDirs.make("ios-screenshot-unexpected-file-");
    const input = collectAll(root);
    fs.writeFileSync(path.join(familyDirectory(input, "watch"), "unexpected.txt"), "unexpected");

    expect(() => reduceAll(input, path.join(root, "reduced"))).toThrow(
      "shard contains unexpected evidence",
    );
  });

  it("rejects artifact paths outside the declared family directory", () => {
    const root = tempDirs.make("ios-screenshot-artifact-path-");
    const input = collectAll(root);
    updateManifest(input, "watch", (manifest) => {
      manifest.screenshots[0].artifactPath = "../iphone/manifest.json";
    });

    expect(() => reduceAll(input, path.join(root, "reduced"))).toThrow(
      "unexpected screenshot artifact path",
    );
  });
});
