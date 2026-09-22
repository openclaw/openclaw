import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopReadinessLines } from "../../scripts/lib/desktop-readiness-proof.mts";
import {
  readDesktopProofTestReport,
  withDesktopProofCleanup,
} from "../../scripts/lib/desktop-resize-proof.mts";
import { testing, type GatewayReadinessDiagnostic } from "../helpers/openclaw-test-instance.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const processState = () =>
  Object.assign(new EventEmitter(), {
    pid: 12345,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  });

async function publicArtifact(readiness: GatewayReadinessDiagnostic[], failure?: unknown) {
  const root = tempDirs.make("desktop-readiness-proof-");
  const report = path.join(root, "vitest.json");
  const status = failure ? "failed" : "passed";
  await writeFile(
    report,
    JSON.stringify({
      numTotalTests: 1,
      numFailedTests: failure ? 1 : 0,
      numFailedTestSuites: failure ? 1 : 0,
      testResults: [
        {
          name: "/fixture/ui/src/e2e/desktop-resize.real-gateway.e2e.test.ts",
          status,
          assertionResults: [
            {
              status,
              failureMessages: failure instanceof Error ? [failure.toString()] : [],
              meta: { desktopProofPhase: "gateway-start", desktopGatewayReadiness: readiness },
            },
          ],
        },
      ],
    }),
  );
  const receipt = path.join(root, "receipt.json");
  await writeFile(receipt, JSON.stringify(await readDesktopProofTestReport(report)));
  return JSON.parse(await readFile(receipt, "utf8")) as Awaited<
    ReturnType<typeof readDesktopProofTestReport>
  >;
}

describe("desktop readiness evidence", () => {
  it("retains timeout probes, timing, and redacted Gateway logs when cleanup also fails", async () => {
    const diagnostics: GatewayReadinessDiagnostic[] = [];
    const cleanup = new Error("fixture cleanup also failed");
    const credential = "ghp_abcdefghijklmnopqrstuvwxyz1234567890ABCD";
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const failure = await withDesktopProofCleanup(
      () =>
        testing.waitForGatewayReady(
          processState(),
          ["[gateway] waiting for startup-sidecars\nmodel: fixture-private-model\n"],
          [`Authorization: Bearer ${credential}\nError opening /private/fixture/state.sqlite\n`],
          12345,
          25,
          fetchImpl,
          undefined,
          (entry) => diagnostics.push(entry),
        ),
      async () => {
        throw cleanup;
      },
      () => {},
    ).catch((error: unknown) => error);
    const artifact = await publicArtifact(diagnostics, failure);
    const entries = artifact.files[0]!.assertions[0]!.gatewayReadiness;
    expect(entries, "public artifact must retain the readiness failure").toHaveLength(1);
    const entry = entries![0]!;
    expect(entry).toMatchObject({
      probe: "GET /readyz",
      outcome: "timeout",
      attempts: 1,
      omittedProbes: 0,
      probes: [{ attempt: 1, phase: "headers", outcome: "timeout", error: "timeout" }],
      child: { exitCode: null, signalCode: null },
      logs: { stdout: ["[gateway] waiting for startup-sidecars", "[model diagnostic omitted]"] },
    });
    expect(entry.deadlineMs - entry.startedAtMs).toBe(25);
    expect(entry.elapsedMs).toBeGreaterThanOrEqual(25);
    expect(entry.probes[0]!.deadlineMs).toBe(entry.deadlineMs);
    expect(entry.probes[0]!.elapsedMs).toBeGreaterThanOrEqual(1);
    const text = JSON.stringify(artifact);
    for (const secret of [
      credential,
      "/private/fixture",
      "state.sqlite",
      "fixture-private-model",
      '"pid"',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(desktopReadinessLines("node", entries!)[0]).toContain(
      "test-node gateway-start timeout elapsed=",
    );
    expect(desktopReadinessLines("node", entries!).join("\n")).toContain(
      "waiting for startup-sidecars",
    );
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) {
      throw failure;
    }
    expect(failure.cause).toBe(failure.errors[0]);
    expect(failure.errors[0].message).toContain("timeout waiting for gateway readiness");
    expect(failure.errors[1]).toBe(cleanup);
  });

  it("keeps the probe deadline within the startup budget as the clock advances", async () => {
    const diagnostics: GatewayReadinessDiagnostic[] = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"ready":true,"failing":[]}', { status: 200 }));
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now++);
    try {
      await testing.waitForGatewayReady(
        processState(),
        [],
        [],
        12345,
        25,
        fetchImpl,
        undefined,
        (entry) => diagnostics.push(entry),
      );
    } finally {
      clock.mockRestore();
    }
    const artifact = await publicArtifact(diagnostics);
    const entries = artifact.files[0]!.assertions[0]!.gatewayReadiness!;
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry).toMatchObject({ outcome: "ready", attempts: 1 });
    expect(entry.deadlineMs - entry.startedAtMs).toBe(25);
    expect(entry.probes[0]!.deadlineMs).toBe(entry.deadlineMs);
  });

  it("does not start a probe when the startup budget expires before admission", async () => {
    const diagnostics: GatewayReadinessDiagnostic[] = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"ready":true,"failing":[]}', { status: 200 }));
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_024)
      .mockReturnValue(1_026);
    let failure: unknown;
    try {
      failure = await testing
        .waitForGatewayReady(processState(), [], [], 12345, 25, fetchImpl, undefined, (entry) =>
          diagnostics.push(entry),
        )
        .catch((error: unknown) => error);
    } finally {
      clock.mockRestore();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("timeout waiting for gateway readiness");
    const artifact = await publicArtifact(diagnostics, failure);
    const entries = artifact.files[0]!.assertions[0]!.gatewayReadiness!;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      outcome: "timeout",
      startedAtMs: 1_000,
      deadlineMs: 1_025,
      attempts: 0,
      probes: [],
      omittedProbes: 0,
    });
  });

  it("records every completed probe and one success timing line", async () => {
    const diagnostics: GatewayReadinessDiagnostic[] = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("private transport detail"))
      .mockResolvedValueOnce(
        new Response('{"ready":false,"failing":["startup-sidecars"]}', { status: 503 }),
      )
      .mockResolvedValueOnce(new Response('{"ready":true,"failing":[]}', { status: 200 }));
    await testing.waitForGatewayReady(
      processState(),
      [],
      [],
      12345,
      60_000,
      fetchImpl,
      undefined,
      (entry) => diagnostics.push(entry),
    );
    const artifact = await publicArtifact(diagnostics);
    const entries = artifact.files[0]!.assertions[0]!.gatewayReadiness!;
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry).toMatchObject({ outcome: "ready", attempts: 3, omittedProbes: 0, logs: null });
    expect(entry.deadlineMs - entry.startedAtMs).toBe(60_000);
    expect(entry.probes.map((probe) => probe.outcome)).toEqual([
      "fetch-failed",
      "not-ready",
      "ready",
    ]);
    expect(entry.probes[1]).toMatchObject({
      status: 503,
      ready: false,
      failing: ["startup-sidecars"],
    });
    expect(
      entry.probes.every((probe) => probe.deadlineMs >= probe.startedAtMs && probe.elapsedMs >= 0),
    ).toBe(true);
    expect(desktopReadinessLines("ssh", entries)).toEqual([
      `[desktop-resize-proof] test-ssh gateway-start ready elapsed=${entry.elapsedMs}ms`,
    ]);
    expect(JSON.stringify(artifact)).not.toContain("private transport detail");
  });
});
