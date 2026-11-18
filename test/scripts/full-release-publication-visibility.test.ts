import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { publicationObservationJson } from "../../scripts/full-release-publication-contract.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  canonicalCandidateRequest,
  registryRecord,
  runCollector,
} from "./full-release-validation-state.test-support.js";

describe("publication upload visibility", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each(["transient", "missing", "forbidden", "wrong-digest", "wrong-producer"])(
    "finalizes only authenticated visible metadata: %s",
    (scenario) => {
      const directory = tempDirs.make("publication-visibility-");
      const bin = join(directory, "bin");
      mkdirSync(bin);
      const record = registryRecord();
      const source = record.sourceAdmission;
      const artifact = record.publicationAdmission.binding.artifact;
      writeFileSync(join(directory, "publication-source-admission.json"), JSON.stringify(source));
      writeFileSync(
        join(directory, "publication-observations.json"),
        publicationObservationJson(record.publicationAdmission.observations),
      );
      const callsPath = join(directory, "calls");
      const delaysPath = join(directory, "delays");
      const preload = join(directory, "clock.mjs");
      // Virtualize only visibility backoff, not subprocess deadlines or production logic.
      writeFileSync(
        preload,
        "import { appendFileSync } from 'node:fs';\n" +
          "const RealDate = Date;\n" +
          "globalThis.Date = class extends RealDate { constructor(...args) { if (args.length) super(...args); else super('2026-09-13T14:00:01.000Z'); } static now() { return RealDate.parse('2026-09-13T14:00:01.000Z'); } };\n" +
          "const real = globalThis.setTimeout;\n" +
          "globalThis.setTimeout = (callback, delay, ...args) => {\n" +
          "  if (![1000, 2000, 4000, 8000].includes(delay)) return real(callback, delay, ...args);\n" +
          "  appendFileSync(process.env.DELAYS_PATH, JSON.stringify(delay) + '\\n');\n" +
          "  queueMicrotask(() => callback(...args));\n" +
          "  return { unref() {} };\n" +
          "};\n",
      );
      const gh = join(bin, "gh");
      writeFileSync(
        gh,
        "#!" +
          process.execPath +
          "\n" +
          "const fs = require('node:fs');\n" +
          "const calls = fs.existsSync(process.env.CALLS_PATH) ? fs.readFileSync(process.env.CALLS_PATH, 'utf8').trim().split('\\n') : [];\n" +
          "fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(process.argv.slice(2)) + '\\n');\n" +
          "const scenario = process.env.SCENARIO;\n" +
          "if (scenario === 'missing' || scenario === 'forbidden' || calls.length === 0) {\n" +
          "  console.error('gh: ' + (scenario === 'forbidden' ? 'Forbidden (HTTP 403)' : 'Not Found (HTTP 404)'));\n" +
          "  process.exit(1);\n" +
          "}\n" +
          "console.log(process.env.METADATA);\n",
      );
      chmodSync(gh, 0o755);
      const result = runCollector("finalize-publication", {
        GITHUB_RUN_ATTEMPT: "1",
        RUNNER_TEMP: directory,
        RERUN_GROUP: "all",
        CANDIDATE_REQUEST_JSON: JSON.stringify(canonicalCandidateRequest()),
        PUBLICATION_UPLOAD_OUTCOME: "success",
        PUBLICATION_ARTIFACT_ID: "456",
        PUBLICATION_ARTIFACT_DIGEST: "d".repeat(64),
        PATH: bin + ":" + process.env.PATH,
        GH_TOKEN: "synthetic-test-token",
        NODE_OPTIONS: "--import=" + pathToFileURL(preload).href,
        CALLS_PATH: callsPath,
        DELAYS_PATH: delaysPath,
        SCENARIO: scenario,
        METADATA: JSON.stringify({
          id: 456,
          name: artifact.name,
          digest: scenario === "wrong-digest" ? "sha256:" + "e".repeat(64) : artifact.digest,
          size_in_bytes: 4096,
          expired: false,
          workflow_run: {
            id: scenario === "wrong-producer" ? 999 : 77,
            head_sha: source.workflow.sha,
            head_branch: "release-ci/tooling",
          },
        }),
      });
      expect(existsSync(callsPath), result.stderr).toBe(true);
      const calls = readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls).toEqual(
        Array.from(
          { length: scenario === "missing" ? 5 : scenario === "forbidden" ? 1 : 2 },
          () => ["api", "repos/openclaw/openclaw/actions/artifacts/456"],
        ),
      );
      const delays = existsSync(delaysPath)
        ? readFileSync(delaysPath, "utf8").trim().split("\n").map(Number)
        : [];
      expect(delays).toEqual(
        scenario === "missing" ? [1000, 2000, 4000, 8000] : scenario === "forbidden" ? [] : [1000],
      );
      const admissionPath = join(directory, "publication-admission.json");
      if (scenario === "transient") {
        expect(result.status, result.stderr).toBe(0);
        const admitted = JSON.parse(readFileSync(admissionPath, "utf8"));
        expect(admitted.sourceAdmission).toEqual(source);
        expect(admitted.publicationAdmission.binding.artifact).toEqual(artifact);
      } else {
        expect(result.status).toBe(2);
        expect(existsSync(admissionPath)).toBe(false);
        expect(result.stderr).toMatch(
          scenario === "missing"
            ? /HTTP 404/
            : scenario === "forbidden"
              ? /HTTP 403/
              : /upload identity mismatch/,
        );
      }
    },
  );
});
