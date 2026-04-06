import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SecretRefCredentialMatrixDocument } from "./credential-matrix.js";

function buildSecretRefCredentialMatrixInSubprocess(): SecretRefCredentialMatrixDocument {
  // Building the matrix pulls in bundled channel registry state. Keep that work out of the
  // Vitest worker so this docs-sync check does not pay the full module-graph cost in-process.
  const childEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  delete childEnv.VITEST;
  delete childEnv.VITEST_MODE;
  delete childEnv.VITEST_POOL_ID;
  delete childEnv.VITEST_WORKER_ID;

  const stdout = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      'import { buildSecretRefCredentialMatrix } from "./src/secrets/credential-matrix.ts"; process.stdout.write(JSON.stringify(buildSecretRefCredentialMatrix()));',
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: childEnv,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as SecretRefCredentialMatrixDocument;
}

describe("secret target registry docs", () => {
  it("stays in sync with docs/reference/secretref-user-supplied-credentials-matrix.json", () => {
    const pathname = path.join(
      process.cwd(),
      "docs",
      "reference",
      "secretref-user-supplied-credentials-matrix.json",
    );
    const raw = fs.readFileSync(pathname, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    expect(parsed).toEqual(buildSecretRefCredentialMatrixInSubprocess());
  });

  it("stays in sync with docs/reference/secretref-credential-surface.md", () => {
    const matrixPath = path.join(
      process.cwd(),
      "docs",
      "reference",
      "secretref-user-supplied-credentials-matrix.json",
    );
    const matrixRaw = fs.readFileSync(matrixPath, "utf8");
    const matrix = JSON.parse(matrixRaw) as SecretRefCredentialMatrixDocument;

    const surfacePath = path.join(
      process.cwd(),
      "docs",
      "reference",
      "secretref-credential-surface.md",
    );
    const surface = fs.readFileSync(surfacePath, "utf8");
    const readMarkedCredentialList = (params: { start: string; end: string }): Set<string> => {
      const startIndex = surface.indexOf(params.start);
      const endIndex = surface.indexOf(params.end);
      expect(startIndex).toBeGreaterThanOrEqual(0);
      expect(endIndex).toBeGreaterThan(startIndex);
      const block = surface.slice(startIndex + params.start.length, endIndex);
      const credentials = new Set<string>();
      for (const line of block.split(/\r?\n/)) {
        const match = line.match(/^- `([^`]+)`/);
        if (!match) {
          continue;
        }
        const candidate = match[1];
        if (!candidate.includes(".")) {
          continue;
        }
        credentials.add(candidate);
      }
      return credentials;
    };

    const supportedFromDocs = readMarkedCredentialList({
      start: '[//]: # "secretref-supported-list-start"',
      end: '[//]: # "secretref-supported-list-end"',
    });
    const unsupportedFromDocs = readMarkedCredentialList({
      start: '[//]: # "secretref-unsupported-list-start"',
      end: '[//]: # "secretref-unsupported-list-end"',
    });

    const supportedFromMatrix = new Set(
      matrix.entries.map((entry) =>
        entry.configFile === "auth-profiles.json" && entry.refPath ? entry.refPath : entry.path,
      ),
    );
    const unsupportedFromMatrix = new Set(matrix.excludedMutableOrRuntimeManaged);

    expect([...supportedFromDocs].toSorted()).toEqual([...supportedFromMatrix].toSorted());
    expect([...unsupportedFromDocs].toSorted()).toEqual([...unsupportedFromMatrix].toSorted());
  });
});
