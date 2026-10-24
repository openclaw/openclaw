import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeWebUiChatEvidence } from "../../scripts/mantis/build-web-ui-chat-evidence.mjs";
import {
  loadEvidenceManifest,
  renderEvidenceComment,
} from "../../scripts/mantis/publish-pr-evidence.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let dir: string;
beforeEach(() => {
  dir = tempDirs.make("openclaw-mantis-web-ui-chat-");
});
const read = (file: string) => readFileSync(file, "utf8");
const metadata = '{"status":"pass"}';
function build(root: string, status: "pass" | "fail", ...args: string[]) {
  const result = writeWebUiChatEvidence(["--output-dir", root, "--status", status, ...args]);
  return {
    ...result,
    loaded: loadEvidenceManifest(result.manifestPath),
    report: read(result.reportPath),
  };
}

function captureAttempt(parent: string, marker: string, complete = true): string {
  const directory = mkdtempSync(path.join(parent, "mantis-chat-proof-"));
  writeFileSync(path.join(directory, "web-ui-chat.png"), `${marker} screenshot`);
  writeFileSync(path.join(directory, "web-ui-chat.webm"), `${marker} video`);
  if (complete) {
    writeFileSync(path.join(directory, "web-ui-chat-proof.json"), metadata);
  }
  return directory;
}

describe("build-web-ui-chat-evidence", () => {
  it("publishes every attempt at its exact retained path without mixing invocation roots", () => {
    const priorRoot = mkdtempSync(path.join(dir, "run-"));
    const priorCapture = captureAttempt(priorRoot, "prior");
    const prior = build(priorRoot, "pass");
    const priorManifest = read(prior.manifestPath);

    const root = mkdtempSync(path.join(dir, "run-"));
    const incomplete = captureAttempt(root, "incomplete", false);
    const complete = captureAttempt(root, "complete");
    writeFileSync(path.join(root, "vitest.log"), "current invocation log");
    const { loaded: manifest, report } = build(
      root,
      "pass",
      "--candidate-ref",
      "main",
      "--candidate-sha",
      "1234567890abcdef1234567890abcdef12345678",
    );
    expect(manifest).toMatchObject({
      id: "web-ui-chat-proof",
      scenario: "web-ui-chat-proof",
      schemaVersion: 2,
      comparison: {
        candidate: { expectationMet: true, fixed: true, ref: "main", status: "pass" },
        pass: true,
      },
    });
    const screenshots = manifest.artifacts.filter(
      (artifact) => artifact.kind === "desktopScreenshot",
    );
    expect(screenshots.map((artifact) => artifact.source).toSorted()).toEqual(
      [incomplete, complete].map((directory) => path.join(directory, "web-ui-chat.png")).toSorted(),
    );
    const comment = renderEvidenceComment({
      manifest,
      marker: "<!-- synthetic-mantis-proof -->",
      rawBase: "https://artifacts.example.test/current",
    });
    for (const [directory, marker] of [
      [incomplete, "incomplete"],
      [complete, "complete"],
    ] as const) {
      const relative = path.basename(directory);
      for (const [file, content] of [
        ["web-ui-chat.png", "screenshot"],
        ["web-ui-chat.webm", "video"],
      ]) {
        const artifact = manifest.artifacts.find((entry) => entry.path === `${relative}/${file}`);
        expect(artifact?.targetPath).toBe(`${relative}/${file}`);
        expect(read(artifact!.source)).toBe(`${marker} ${content}`);
        expect(comment).toContain(`https://artifacts.example.test/current/${relative}/${file}`);
        expect(report).toContain(`${relative}/${file}`);
      }
    }
    expect(read(prior.reportPath)).toBe(prior.report);
    expect(read(prior.manifestPath)).toBe(priorManifest);
    expect(read(path.join(priorCapture, "web-ui-chat.png"))).toBe("prior screenshot");
    expect(report).not.toContain(path.basename(priorCapture));
  });

  it("retains setup failures before a capture exists as publishable failure evidence", () => {
    writeFileSync(path.join(dir, "setup.log"), "candidate installation failed");
    const { loaded: manifest, report } = build(dir, "fail");
    expect(manifest.comparison).toMatchObject({
      candidate: { expectationMet: false, status: "fail" },
      pass: false,
    });
    expect(manifest.artifacts.map((artifact) => artifact.targetPath)).toEqual([
      "setup.log",
      "mantis-report.md",
      "mantis-evidence.json",
    ]);
    expect(manifest.summary).toContain("could not complete");
    expect(report).toContain("`setup.log` (present)");
  });

  it("keeps a failed process verdict even when an attempt completed its captures", () => {
    captureAttempt(dir, "completed before process failure");
    const result = build(dir, "fail");
    expect(result.loaded.comparison.pass).toBe(false);
    expect(result.report).toContain("Status: fail");
  });

  it.each(["absent", "old flat files", "split attempts"])(
    "rejects a passing verdict with %s instead of using unrelated proof",
    (kind) => {
      if (kind === "old flat files") {
        writeFileSync(path.join(dir, "web-ui-chat.png"), "old screenshot");
        writeFileSync(path.join(dir, "web-ui-chat-proof.json"), metadata);
      } else if (kind === "split attempts") {
        captureAttempt(dir, "screenshot only", false);
        const metadataOnly = mkdtempSync(path.join(dir, "mantis-chat-proof-"));
        writeFileSync(path.join(metadataOnly, "web-ui-chat-proof.json"), metadata);
      }
      expect(() => build(dir, "pass")).toThrow(
        "Passing proof requires a captured screenshot and proof metadata",
      );
      expect(existsSync(path.join(dir, "mantis-evidence.json"))).toBe(false);
    },
  );

  it("refuses to rewrite reports when the builder is replayed against the same invocation", () => {
    captureAttempt(dir, "original");
    const original = build(dir, "pass");
    const manifest = read(original.manifestPath);
    const retry = captureAttempt(dir, "retained retry", false);
    expect(() => build(dir, "fail")).toThrow("use a fresh invocation directory");
    expect(read(original.reportPath)).toBe(original.report);
    expect(read(original.manifestPath)).toBe(manifest);
    expect(read(path.join(retry, "web-ui-chat.png"))).toBe("retained retry screenshot");
  });
});
