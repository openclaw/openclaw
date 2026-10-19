import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, expect, it } from "vitest";
import {
  createRequestReceipt,
  createTelegramFailureDiagnostic,
} from "../../scripts/mantis/request-proof.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { identity, makeIngress } from "./mantis-telegram.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const evidence = { artifact_id: "789", artifact_name: "fixture", sha256: "e".repeat(64) };
const encode = (value: unknown) => ({
  "telegram-failure.json": Buffer.from(JSON.stringify(value)).toString("base64"),
});
function receipt(value: unknown, execution: "failed" | "completed" = "failed", reason?: string) {
  return createRequestReceipt(identity, execution, evidence, encode(value), reason);
}
const makeDiagnostic = (category = "scope_rejected") =>
  createTelegramFailureDiagnostic(identity, [{ sequence: 1, category }]);

it("binds diagnostics without certifying absent captures", () => {
  const facts = makeDiagnostic();
  for (const execution of ["failed", "completed"] as const) {
    expect(receipt(facts, execution)).toMatchObject({
      assertion_outcome: "inconclusive",
      observations: [],
      reason: expect.stringContaining("1:scope_rejected"),
    });
  }
  const authorityReason = "PR is no longer open at the exact same-repository candidate head.";
  for (const value of [facts, { ...facts, raw: "private payload" }]) {
    expect(receipt(value, "failed", authorityReason).reason).toBe(authorityReason);
  }
  for (const changed of [
    { ...facts, candidate_sha: "f".repeat(40) },
    { ...facts, plan_sha256: "f".repeat(64) },
    { ...facts, run: { id: "457", attempt: 1 } },
    { ...facts, request_id: "f".repeat(64) },
    { ...facts, raw: "private payload" },
  ]) {
    const result = receipt(changed);
    expect(result).toMatchObject({
      reason: expect.stringContaining("malformed"),
      assertion_outcome: "inconclusive",
    });
    expect(JSON.stringify(result)).not.toContain("private payload");
  }
  for (const entries of [
    [],
    [{ sequence: 2, category: "scope_rejected" }],
    [{ sequence: 1, category: "private payload" }],
    [{ sequence: 1, category: "scope_rejected", message: "private payload" }],
    Array.from({ length: 17 }, (_, i) => ({ sequence: i + 1, category: "scope_rejected" })),
  ]) {
    expect(() => createTelegramFailureDiagnostic(identity, entries)).toThrow();
  }
  expect(createRequestReceipt(identity, "completed", null, undefined).assertion_outcome).toBe(
    "inconclusive",
  );
});

it("isolates diagnostic-only archives", async () => {
  const root = tempDirs.make("tg-diagnostic-");
  const facts = makeDiagnostic("upstream_failure");
  for (const variant of ["valid", "mixed", "extra", "oversized"]) {
    const zip = new JSZip();
    zip.file(
      "telegram-failure.json",
      variant === "oversized" ? "x".repeat(16385) : JSON.stringify(facts),
    );
    if (variant === "mixed") {
      zip.file("telegram-send.json", "{}");
    }
    if (variant === "extra") {
      zip.file("raw.log", "private payload");
    }
    const archive = path.join(root, `${variant}.zip`),
      output = path.join(root, `${variant}.json`);
    await writeFile(archive, await zip.generateAsync({ type: "nodebuffer" }));
    const parser = "scripts/mantis/read-request-archive.py";
    const args = ["-I", "-S", parser, "telegram-evidence", archive, output];
    const run = () => execFileSync("python3", args, { stdio: "pipe" });
    if (variant === "valid") {
      run();
      const files = JSON.parse(await readFile(output, "utf8"));
      const result = createRequestReceipt(identity, "failed", evidence, files);
      expect(result.reason).toContain("upstream_failure");
    } else {
      expect(run).toThrow();
    }
  }
});

it.each([
  "scope_rejected",
  "malformed_request",
  "upstream_failure",
  "network_failure",
  "authority_unavailable",
] as const)("redacts and bounds %s diagnostics through ingress", async (expected) => {
  const root = tempDirs.make("sock-");
  const fixture = await makeIngress(root, {
    lease: {
      assertHealthy() {
        if (expected === "authority_unavailable") {
          throw new Error("private expired lease");
        }
      },
      whenUnhealthy: new Promise<Error>(() => {}),
    },
    fetchImpl: async () => {
      if (expected === "network_failure") {
        throw new Error("private network secret");
      }
      return new Response("private upstream secret", { status: 500 });
    },
  });
  try {
    const { ingress } = fixture;
    const request = () =>
      fixture.request(
        "getMe",
        expected === "malformed_request" ? "private-not-json" : {},
        expected === "scope_rejected" ? "/private-wrong-capability" : undefined,
      );
    expect(await request()).toBe(403);
    expect(ingress.getDiagnostics().some((entry) => entry.category === expected)).toBe(true);
    if (expected === "authority_unavailable") {
      expect(ingress.getDiagnostics()).toEqual([
        { sequence: 1, category: "authority_unavailable" },
      ]);
    }
    for (let i = 0; i < 20; i++) {
      await request();
    }
    const diagnostic = createTelegramFailureDiagnostic(identity, ingress.getDiagnostics());
    expect(diagnostic.diagnostics).toHaveLength(16);
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|token|secret/);
    const copy = ingress.getDiagnostics();
    copy.splice(0);
    expect(ingress.getDiagnostics()).toHaveLength(16);
  } finally {
    await fixture.close();
  }
});
