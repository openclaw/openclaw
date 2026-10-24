import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  emitDiagnosticsTimelineEvent as emit,
  flushDiagnosticsTimeline as flush,
  isDiagnosticsTimelineEnabled as isEnabled,
  measureDiagnosticsTimelineSpan as span,
  measureDiagnosticsTimelineSpanSync as spanSync,
} from "./diagnostics-timeline.js";
import { nativeProcessTestEntrypoints } from "./native-process-runtime.test-support.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

const tempDirs: string[] = [];
const timelineUrl = resolveRuntimeWorkerUrl(nativeProcessTestEntrypoints.diagnosticsTimeline);

async function createTimelineEnv() {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-diagnostics-timeline-"));
  tempDirs.push(dir);
  return {
    env: {
      OPENCLAW_DIAGNOSTICS: "timeline",
      OPENCLAW_DIAGNOSTICS_RUN_ID: "run-1",
      OPENCLAW_DIAGNOSTICS_ENV: "env-1",
      OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: join(dir, "nested", "timeline.jsonl"),
    } as NodeJS.ProcessEnv,
    path: join(dir, "nested", "timeline.jsonl"),
  };
}

async function readTimeline(path: string) {
  flush();
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(async () => {
  flush();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("defers a timeline burst and writes its ordered events in one safe append", async () => {
  const { env, path } = await createTimelineEnv();
  const open = vi.spyOn(fs, "openSync");
  const names = Array.from({ length: 64 }, (_, index) => `event-${index}`);

  for (const name of names) {
    emit({ type: "mark", name }, { env });
  }

  expect(open.mock.calls.filter(([file]) => file === path)).toHaveLength(0);
  await yieldToEventLoop();
  expect(open.mock.calls.filter(([file]) => file === path)).toHaveLength(1);
  expect((await readTimeline(path)).map((event) => event.name)).toEqual(names);
  expect(fs.statSync(path).mode & 0o777).toBe(0o600);
});

it("captures emitted values and flushes earlier paths before switching destinations", async () => {
  const first = await createTimelineEnv();
  const second = await createTimelineEnv();
  const attributes = { value: "before" };
  emit({ type: "mark", name: "first", attributes }, { env: first.env });
  attributes.value = "after";
  first.env.OPENCLAW_DIAGNOSTICS_RUN_ID = "changed";
  first.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH = second.path;
  emit({ type: "mark", name: "second", attributes }, { env: first.env });

  expect(JSON.parse(fs.readFileSync(first.path, "utf8"))).toMatchObject({
    name: "first",
    runId: "run-1",
    attributes: { value: "before" },
  });
  expect(fs.existsSync(second.path)).toBe(false);
  first.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH = first.path;
  emit({ type: "mark", name: "third" }, { env: first.env });
  expect(JSON.parse(fs.readFileSync(second.path, "utf8"))).toMatchObject({
    name: "second",
    runId: "changed",
    attributes: { value: "after" },
  });
  expect((await readTimeline(first.path)).map((event) => event.name)).toEqual(["first", "third"]);
});

it("bounds queued UTF-8 bytes without dropping bursts or oversized events", async () => {
  const { env, path } = await createTimelineEnv();
  const write = vi.spyOn(fs, "appendFileSync");
  const names = Array.from({ length: 6 }, (_, index) => `event-${index}`);
  for (const name of names) {
    emit({ type: "mark", name, attributes: { text: "界".repeat(8192) } }, { env });
  }
  const sizes = () => write.mock.calls.map(([, content]) => Buffer.byteLength(content));
  expect(sizes().length).toBeGreaterThan(0);
  expect(sizes().every((size) => size <= 64 * 1024)).toBe(true);
  const oversized = "界".repeat(32 * 1024);
  emit({ type: "mark", name: "oversized", attributes: { text: oversized } }, { env });
  emit({ type: "mark", name: "last" }, { env });
  flush();

  expect(sizes().filter((size) => size > 64 * 1024)).toHaveLength(1);
  const events = await readTimeline(path);
  expect(events.map((event) => event.name)).toEqual([...names, "oversized", "last"]);
  const oversizedEvent = expectDefined(events[names.length], "oversized timeline event");
  expect(oversizedEvent).toMatchObject({ attributes: { text: oversized } });
});

it.each(["natural", "immediate", "first-event-at-exit"])(
  "retains queued and later exit-listener events on %s exit",
  async (mode) => {
    const { env, path } = await createTimelineEnv();
    const script = `
        import { emitDiagnosticsTimelineEvent as emit } from ${JSON.stringify(timelineUrl.href)};
        const env = ${JSON.stringify(env)};
        process.on("exit", () => emit({ type: "mark", name: "last" }, { env }));
        ${mode === "first-event-at-exit" ? "" : 'emit({ type: "mark", name: "first" }, { env });'}
        ${mode === "natural" ? "" : "process.exit(0);"}
      `;
    const result = spawnSync(
      process.execPath,
      [
        ...resolveRuntimeWorkerArgv(timelineUrl).slice(0, -1),
        "--input-type=module",
        "--eval",
        script,
      ],
      { encoding: "utf8", env: { ...process.env, VITEST: "false" }, timeout: 10_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect((await readTimeline(path)).map((event) => event.name)).toEqual(
      mode === "first-event-at-exit" ? ["last"] : ["first", "last"],
    );
  },
);

it("detects when timeline output is enabled", async () => {
  const { env } = await createTimelineEnv();

  for (const flag of ["timeline", "1", "yes", "on", "all", "*", "diagnostics.timeline"]) {
    expect(isEnabled({ env: { ...env, OPENCLAW_DIAGNOSTICS: flag } })).toBe(true);
  }
  for (const flag of ["telegram.http", "0"]) {
    expect(isEnabled({ env: { ...env, OPENCLAW_DIAGNOSTICS: flag } })).toBe(false);
  }
  expect(isEnabled({ env: { ...env, OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: "" } })).toBe(false);
});

it("skips flag resolution when no timeline output is configured", () => {
  const flags = vi.fn(() => "timeline");
  const env: NodeJS.ProcessEnv = {
    get OPENCLAW_DIAGNOSTICS() {
      return flags();
    },
  };
  expect(isEnabled({ env })).toBe(false);
  expect(flags).not.toHaveBeenCalled();
  env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH = "timeline.jsonl";
  expect(isEnabled({ env })).toBe(true);
  expect(flags).toHaveBeenCalledTimes(1);
});

it.each([
  {
    type: "mark",
    name: "gateway.ready",
    phase: "startup",
    attributes: { ok: true, count: 2, ignored: Number.NaN },
  },
  {
    type: "provider.request",
    name: "provider.request",
    provider: "openai",
    operation: "openai-responses",
    ok: true,
    status: 200,
  },
] as const)("writes $type fields in the stable JSONL envelope", async (input) => {
  const { env, path } = await createTimelineEnv();
  emit(input, { env });
  const [event] = await readTimeline(path);
  expect(event).toMatchObject({
    ...input,
    ...(input.type === "mark" ? { attributes: { ok: true, count: 2 } } : {}),
    schemaVersion: "openclaw.diagnostics.v1",
    runId: "run-1",
    envName: "env-1",
    timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
    pid: process.pid,
  });
  if (input.type === "mark") {
    expect(event?.attributes).not.toHaveProperty("ignored");
  }
});

it("routes timeline write failures through the captured console boundary once", async () => {
  const { env, path } = await createTimelineEnv();
  await mkdir(dirname(path), { recursive: true });
  const blockingFile = join(dirname(path), "blocked");
  await writeFile(blockingFile, "not a directory");
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const failingEnv = {
    ...env,
    OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: join(blockingFile, "timeline.jsonl"),
  };

  emit({ type: "mark", name: "first" }, { env: failingEnv });
  emit({ type: "mark", name: "second" }, { env: failingEnv });
  flush();

  expect(warnSpy).toHaveBeenCalledTimes(1);
  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("failed to write timeline event"));
  emit({ type: "mark", name: "recovered" }, { env });
  expect((await readTimeline(path)).map((event) => event.name)).toEqual(["recovered"]);
});

it.each(["symlink", "hardlink", "directory"])(
  "keeps unsafe %s targets unchanged when a batch drains",
  async (kind) => {
    const { env, path } = await createTimelineEnv();
    await mkdir(dirname(path), { recursive: true });
    const target = join(dirname(path), "target");
    await writeFile(target, "unchanged");
    if (kind === "symlink") {
      fs.symlinkSync(target, path);
    } else if (kind === "hardlink") {
      fs.linkSync(target, path);
    } else {
      await mkdir(path);
    }
    emit({ type: "mark", name: "first" }, { env });
    emit({ type: "mark", name: "second" }, { env });
    flush();

    expect(await readFile(target, "utf8")).toBe("unchanged");
    if (kind === "directory") {
      expect(fs.readdirSync(path)).toEqual([]);
    }
  },
);

it.each([false, true])(
  "records and rethrows span errors with omission=%s",
  async (omitErrorMessage) => {
    const { env, path } = await createTimelineEnv();
    const name = omitErrorMessage ? "secrets.prepare" : "plugins.load";
    const error = omitErrorMessage
      ? new Error('Secret provider "prod" failed for ref "TOKEN_ID"')
      : new TypeError("bad plugin");
    await expect(
      span(
        name,
        () => {
          throw error;
        },
        { env, omitErrorMessage, phase: "startup" },
      ),
    ).rejects.toThrow(omitErrorMessage ? "TOKEN_ID" : "bad plugin");
    const events = await readTimeline(path);
    expect(events).toHaveLength(2);
    const errorEvent = expectDefined(events[1], "span error");
    expect(errorEvent).toMatchObject({
      type: "span.error",
      name,
      phase: "startup",
      errorName: omitErrorMessage ? "Error" : "TypeError",
    });
    if (omitErrorMessage) {
      expect(errorEvent.errorMessage).toBeUndefined();
      expect(JSON.stringify(events)).not.toContain("TOKEN_ID");
      expect(JSON.stringify(events)).not.toContain("prod");
    } else {
      expect(errorEvent.errorMessage).toBe("bad plugin");
    }
  },
);

it("lets nested spans inherit the active timeline phase and parent span", async () => {
  const { env, path } = await createTimelineEnv();
  const configOnlyEnv = { ...env };
  delete configOnlyEnv.OPENCLAW_DIAGNOSTICS;

  const result = await span(
    "reply.run_agent_turn",
    () => spanSync("plugins.metadata.scan", () => 42, { env }),
    {
      env: configOnlyEnv,
      config: { diagnostics: { flags: ["timeline"] } } as OpenClawConfig,
      attributes: { pluginCount: 3 },
      phase: "agent-turn",
    },
  );

  expect(result).toBe(42);
  const events = await readTimeline(path);
  expect(events).toHaveLength(4);
  const parent = {
    name: "reply.run_agent_turn",
    phase: "agent-turn",
    attributes: { pluginCount: 3 },
    spanId: events[0]?.spanId,
  };
  const child = {
    name: "plugins.metadata.scan",
    phase: "agent-turn",
    parentSpanId: events[0]?.spanId,
  };
  expect(events).toMatchObject([
    { ...parent, type: "span.start" },
    { ...child, type: "span.start" },
    { ...child, type: "span.end" },
    { ...parent, type: "span.end" },
  ]);
  expect(events[3]?.durationMs).toBeGreaterThanOrEqual(0);
});
