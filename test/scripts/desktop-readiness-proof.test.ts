import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
import { desktopReadinessLines } from "../../scripts/lib/desktop-readiness-proof.mts";
import {
  desktopProofTestReport,
  withDesktopProofCleanup,
} from "../../scripts/lib/desktop-resize-proof.mts";
import { testing, type GatewayReadinessDiagnostic } from "../helpers/openclaw-test-instance.ts";
const processState = () =>
  Object.assign(new EventEmitter(), {
    pid: 12345,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  });
let diagnostics: GatewayReadinessDiagnostic[];
beforeEach(() => {
  diagnostics = [];
});
const waitForReady = (
  fetchImpl: typeof fetch,
  timeout = 25,
  stdout: string[] = [],
  stderr: string[] = [],
) =>
  testing.waitForGatewayReady(
    processState(),
    stdout,
    stderr,
    12345,
    timeout,
    fetchImpl,
    undefined,
    (entry) => diagnostics.push(entry),
  );

function evidence(failure?: unknown) {
  const status = failure ? "failed" : "passed";
  const assertionResults = [
    {
      status,
      failureMessages: failure instanceof Error ? [failure.toString()] : [],
      meta: { desktopProofPhase: "gateway-start", desktopGatewayReadiness: diagnostics },
    },
  ];
  const artifact = desktopProofTestReport({
    numTotalTests: 1,
    numFailedTests: failure ? 1 : 0,
    numFailedTestSuites: failure ? 1 : 0,
    testResults: [
      {
        name: "/fixture/ui/src/e2e/desktop-resize.real-gateway.e2e.test.ts",
        status,
        assertionResults,
      },
    ],
  });
  const entries = artifact.files[0]!.assertions[0]!.gatewayReadiness!;
  expect(entries, "public artifact must retain readiness evidence").toHaveLength(1);
  return { artifact, entries, entry: entries[0]! };
}

it("retains timeout probes, timing, and redacted Gateway logs when cleanup also fails", async () => {
  const cleanup = new Error("fixture cleanup also failed");
  const credential = "ghp_abcdefghijklmnopqrstuvwxyz1234567890ABCD";
  const fetchImpl = vi.fn<typeof fetch>(() => new Promise(() => {}));
  const failure = await withDesktopProofCleanup(
    () =>
      waitForReady(
        fetchImpl,
        25,
        ["[gateway] waiting for startup-sidecars\nmodel: fixture-private-model\n"],
        [`Authorization: Bearer ${credential}\nError opening /private/fixture/state.sqlite\n`],
      ),
    () => Promise.reject(cleanup),
    () => {},
  ).catch((error: unknown) => error);
  const { artifact, entries, entry } = evidence(failure);
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
  expect(text).not.toContain(credential);
  expect(text).not.toMatch(/\/private\/fixture|state\.sqlite|fixture-private-model|"pid"/u);
  expect(desktopReadinessLines("node", entries)[0]).toContain(
    "test-node gateway-start timeout elapsed=",
  );
  expect(desktopReadinessLines("node", entries).join("\n")).toContain(
    "waiting for startup-sidecars",
  );
  assert(failure instanceof AggregateError);
  expect(failure.cause).toBe(failure.errors[0]);
  expect(failure.errors[0].message).toContain("timeout waiting for gateway readiness");
  expect(failure.errors[1]).toBe(cleanup);
});

it.each([false, true])(
  "keeps probe admission inside the startup budget (expired: %s)",
  async (expired) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"ready":true,"failing":[]}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"ok":true,"status":"started"}', { status: 200 }));
    let now = 1_000;
    const ticks = [1_000, 1_024];
    const clock = vi
      .spyOn(Date, "now")
      .mockImplementation(() => (expired ? (ticks.shift() ?? 1_026) : now++));
    let failure: unknown;
    try {
      failure = await waitForReady(fetchImpl).catch((error: unknown) => error);
    } finally {
      clock.mockRestore();
    }
    const { entry } = evidence(failure);
    if (expired) {
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain("timeout waiting for gateway readiness");
      expect(entry).toMatchObject({
        outcome: "timeout",
        startedAtMs: 1_000,
        deadlineMs: 1_025,
        attempts: 0,
        probes: [],
        omittedProbes: 0,
      });
    } else {
      expect(failure).toBeUndefined();
      expect(entry).toMatchObject({ outcome: "ready", attempts: 1 });
      expect(entry.deadlineMs - entry.startedAtMs).toBe(25);
      expect(entry.probes[0]!.deadlineMs).toBe(entry.deadlineMs);
    }
  },
);

it("records every completed probe and one success timing line", async () => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("private transport detail"))
    .mockResolvedValueOnce(
      new Response('{"ready":false,"failing":["startup-sidecars"]}', { status: 503 }),
    )
    .mockResolvedValueOnce(new Response('{"ready":true,"failing":[]}', { status: 200 }))
    .mockResolvedValueOnce(new Response('{"ok":true,"status":"started"}', { status: 200 }));
  await waitForReady(fetchImpl, 60_000);
  const { artifact, entries, entry } = evidence();
  expect(entry).toMatchObject({ outcome: "ready", attempts: 3, omittedProbes: 0, logs: null });
  expect(entry.deadlineMs - entry.startedAtMs).toBe(60_000);
  const outcomes = entry.probes.map((probe) => probe.outcome);
  expect(outcomes).toEqual(["fetch-failed", "not-ready", "ready"]);
  const notReady = entry.probes[1];
  expect(notReady).toMatchObject({ status: 503, ready: false, failing: ["startup-sidecars"] });
  expect(
    entry.probes.every((probe) => probe.deadlineMs >= probe.startedAtMs && probe.elapsedMs >= 0),
  ).toBe(true);
  expect(desktopReadinessLines("ssh", entries)).toEqual([
    `[desktop-resize-proof] test-ssh gateway-start ready elapsed=${entry.elapsedMs}ms`,
  ]);
  expect(JSON.stringify(artifact)).not.toContain("private transport detail");
});
