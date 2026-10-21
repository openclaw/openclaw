import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { flushDiagnosticsTimeline } from "../infra/diagnostics-timeline.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createGatewayDispatchStartupTrace } from "./startup-trace.js";

function readTimelineEvents(timelinePath: string): Record<string, unknown>[] {
  flushDiagnosticsTimeline();
  return fs
    .readFileSync(timelinePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const directories = useAutoCleanupTempDirTracker(afterEach);
const timelineEvent = (type: string, name: string, fields = {}) =>
  expect.objectContaining({ type, name: `entry.${name}`, phase: "cli.startup", ...fields });
const stderrWrite = vi.fn<typeof process.stderr.write>(() => true);
const messages = () => stderrWrite.mock.calls.map(([line]) => String(line));
const makeTrace = (args: string[], source: "entry" | "cli.main" = "entry") =>
  createGatewayDispatchStartupTrace(["node", "openclaw", ...args], source);

function timelineFixture(diagnostics: string) {
  const timelinePath = path.join(directories.make("openclaw-startup-trace-"), "timeline.jsonl");
  vi.stubEnv("OPENCLAW_DIAGNOSTICS", diagnostics);
  vi.stubEnv("OPENCLAW_DIAGNOSTICS_TIMELINE_PATH", timelinePath);
  const trace = makeTrace(["agent", "--local"]);
  trace.mark("bootstrap");
  return { trace, timelinePath };
}

beforeEach(() => {
  vi.stubEnv("OPENCLAW_GATEWAY_STARTUP_TRACE", "0");
  stderrWrite.mockClear();
  vi.spyOn(process.stderr, "write").mockImplementation(stderrWrite);
});
afterEach(() => {
  flushDiagnosticsTimeline();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each(["gateway", "status"])("foreground progress: %s", async (command) => {
  const trace = makeTrace([command]);
  trace.setLineFormatter((message) => message);
  const pending = createDeferredCore<string>();
  const loading = trace.measure("run-main-import", () => pending.promise);
  expect(messages()).toEqual(
    command === "gateway"
      ? [expect.stringMatching(/startup phase: entry.run-main-import starting total=\d+\.\dms/)]
      : [],
  );
  pending.resolve("loaded");
  await expect(loading).resolves.toBe("loaded");
  expect(messages()).toHaveLength(command === "gateway" ? 2 : 0);
  if (command === "gateway") {
    expect(messages()[1]).toMatch(/startup phase: entry.run-main-import \d+\.\dms total=/);
  }
});

it.each([
  [false, 2],
  [true, 0],
  [true, 1],
  [true, 2],
  [true, 3],
] as const)(
  "reports milestones only to a supporting updater (gateway: %s, markers: %i)",
  async (gateway, markers) => {
    const trace = makeTrace(
      [
        ...(gateway ? ["gateway", "run"] : ["agent"]),
        ...Array.from({ length: markers }, () => "--update-canary"),
      ],
      "cli.main",
    );
    trace.mark("argv");
    trace.mark("tick.1");
    await trace.measure("gateway-run-imports.tick.2", async () => {});
    expect(await trace.measure("gateway-run-imports", async () => "loaded")).toBe("loaded");
    await expect(
      trace.measure("gateway-run-bootstrap", () => Promise.reject(new Error("bootstrap failed"))),
    ).rejects.toThrow("bootstrap failed");
    expect(messages()).toEqual(
      gateway && markers >= 2
        ? [
            "openclaw-update-canary-progress: cli.main.argv\n",
            "openclaw-update-canary-progress: cli.main.gateway-run-imports\n",
          ]
        : [],
    );
  },
);

it("records entry marks and measured spans in the diagnostics timeline", async () => {
  const { trace, timelinePath } = timelineFixture("timeline");
  await trace.measure("run-main-import", () => Promise.resolve());
  await expect(
    trace.measure("command-execution", async () => "done", { timeline: false }),
  ).resolves.toBe("done");

  const events = readTimelineEvents(timelinePath);
  expect(events).toEqual(
    expect.arrayContaining([
      timelineEvent("mark", "bootstrap", {
        durationMs: expect.any(Number),
        attributes: expect.objectContaining({ totalMs: expect.any(Number) }),
      }),
      timelineEvent("span.start", "run-main-import"),
      timelineEvent("span.end", "run-main-import", { durationMs: expect.any(Number) }),
    ]),
  );
  expect(events).not.toContainEqual(expect.objectContaining({ name: "entry.command-execution" }));
});

it("flushes buffered startup phases when config enables the timeline", async () => {
  const { trace, timelinePath } = timelineFixture("");
  await trace.measure("run-main-import", async () => "loaded");

  expect(await trace.requiresDiagnosticsConfig()).toBe(true);
  expect(fs.existsSync(timelinePath)).toBe(false);

  await trace.configureDiagnosticsTimeline({ diagnostics: { flags: ["timeline"] } });

  expect(readTimelineEvents(timelinePath)).toEqual(
    expect.arrayContaining([
      timelineEvent("mark", "bootstrap"),
      timelineEvent("span.end", "run-main-import", { durationMs: expect.any(Number) }),
    ]),
  );
});
