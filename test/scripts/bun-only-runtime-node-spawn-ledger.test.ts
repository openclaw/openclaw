import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attributeSpawns,
  classifyNodeSpawns,
  renderMarkdownReport,
} from "../../scripts/e2e/lib/bun-only-runtime/node-spawn-ledger.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const step = {
  name: "terminals",
  startMs: 100,
  endMs: 200,
  sentinelStart: 0,
  sentinelEnd: 1,
  status: "passed",
};
const trace = {
  childPid: 20,
  pid: 10,
  ppid: 1,
  ts: 150,
  cmd: ["/sentinels/node", "--eval", 'const requiredFlag="";'],
  cwd: "/smoke",
  stack: [
    "at resolveNodeRuntimeExecutable (runtime.js:1:1)",
    "at spawnNodeTerminalPty (pty.js:2:2)",
  ],
};
const sentinel = {
  name: "node",
  pid: 20,
  ppid: 10,
  cwd: "/smoke",
  argv: trace.cmd.slice(1),
  ancestors: [{ pid: 10, cmdline: "bun\0openclaw.mjs\0gateway\0run\0\0" }],
};
const blocker = {
  id: "terminal-pty",
  feature: "Terminals",
  origin: "known-blocker",
  owner: "terminals task",
  callSite: "spawnNodeTerminalPty -> resolveNodeRuntimeExecutable",
  step: "terminals",
  evidence: "spawn",
  match: {
    stack: ["spawnNodeTerminalPty", "resolveNodeRuntimeExecutable"],
    argv: ["--eval", "requiredFlag"],
  },
};
type AttributionInput = Parameters<typeof attributeSpawns>[0];
const attribute = (
  traceRecords: AttributionInput["traceRecords"] = [trace],
  sentinelRecords: AttributionInput["sentinelRecords"] = [sentinel],
) => attributeSpawns({ sentinelRecords, traceRecords, steps: [step] });

describe("Bun-only Node spawn ledger", () => {
  it.each(["unexpected", "matched", "stack mismatch", "argv mismatch", "failed step"])(
    "classifies and reports a %s spawn",
    (kind) => {
      const match =
        kind === "stack mismatch"
          ? { stack: ["differentOwner"] }
          : kind === "argv mismatch"
            ? { argv: ["--permission"] }
            : blocker.match;
      const result = classifyNodeSpawns({
        attempts: attribute(),
        steps: [kind === "failed step" ? { ...step, status: "failed", exitCode: 1 } : step],
        blockers: kind === "unexpected" ? [] : [{ ...blocker, match }],
      });
      expect(result.ok).toBe(kind === "matched");
      if (kind === "matched" || kind === "failed step") {
        expect(result.blockers[0]).toMatchObject({ status: "reproduced", reproducedBy: ["spawn"] });
        expect(renderMarkdownReport(result)).toContain(
          "| terminal-pty | known-blocker | reproduced | 1 | spawn |",
        );
      } else {
        expect(result.unexpectedAttempts).toHaveLength(1);
      }
      if (kind === "failed step") {
        expect(result.failedSteps).toHaveLength(1);
      }
      if (kind === "unexpected") {
        expect(renderMarkdownReport(result)).toContain(JSON.stringify(["node", ...sentinel.argv]));
        expect(renderMarkdownReport(result)).toContain(
          'ancestor 10: "bun openclaw.mjs gateway run"',
        );
        expect(result.attempts).toMatchObject([{ ancestors: sentinel.ancestors }]);
        expect(renderMarkdownReport(result)).toContain("spawnNodeTerminalPty");
        expect(
          renderMarkdownReport({ ...result, bunVersion: "1.4.3", bunRevision: "test-revision" }),
        ).toContain("Bun 1.4.3 (test-revision)");
      }
    },
  );

  it("explains a node-host spawn in a later step but never an earlier step", () => {
    const steps = ["gateway", "node-host", "agent"].map((name, index) => ({
      name,
      status: "passed",
      startMs: 100 + index * 200,
      endMs: 200 + index * 200,
      sentinelStart: index,
      sentinelEnd: index + 1,
    }));
    const nodeHostTrace = {
      ...trace,
      cmd: ["npm", "view", "openclaw@latest"],
      stack: ["at fetchNpmPackageTargetStatus (update.js:1:1)"],
    };
    const attempts = attributeSpawns({
      steps,
      traceRecords: [250, 450, 650].map((ts, index) => ({
        childPid: sentinel.pid + index,
        pid: nodeHostTrace.pid,
        ppid: nodeHostTrace.ppid,
        cmd: nodeHostTrace.cmd,
        stack: nodeHostTrace.stack,
        ts,
      })),
      sentinelRecords: [0, 1, 2].map((index) => ({
        pid: sentinel.pid + index,
        ppid: sentinel.ppid,
        cwd: sentinel.cwd,
        ancestors: sentinel.ancestors,
        index,
        name: "npm",
        argv: nodeHostTrace.cmd.slice(1),
      })),
    });
    expect(attempts.map((attempt) => attempt.step)).toEqual(["gateway", "node-host", "agent"]);
    const result = classifyNodeSpawns({
      attempts,
      steps,
      blockers: [
        {
          ...blocker,
          step: "node-host",
          match: { stack: ["fetchNpmPackageTargetStatus"], argv: ["view", "openclaw@latest"] },
        },
      ],
    });
    expect(result.blockers).toMatchObject([{ matchedAttempts: attempts.slice(1) }]);
    expect(result.unexpectedAttempts).toEqual([attempts[0]]);
    expect(result.staleBlockers).toEqual([]);
  });

  it.each([{ evidence: "failure" }, { evidence: ["spawn", "failure"] }])(
    "reproduces failure evidence %j without requiring a cached probe to spawn again",
    ({ evidence }) => {
      const result = classifyNodeSpawns({
        attempts: [],
        steps: [{ ...step, stderr: "A Node executable is required for terminals on Bun" }],
        blockers: [
          { ...blocker, evidence, failure: "A Node executable is required for terminals" },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.blockers[0]).toMatchObject({ status: "reproduced", reproducedBy: ["failure"] });
      if (evidence === "failure") {
        const withSpawn = classifyNodeSpawns({ ...result, attempts: attribute() });
        expect(withSpawn.unexpectedAttempts).toHaveLength(1);
      }
    },
  );

  it.each(["stale", "not-exercised"])("reports a %s blocker without spawn evidence", (status) => {
    const exercised = status === "stale";
    const reason = "Desktop provider is not enabled.";
    const result = classifyNodeSpawns({
      attempts: [],
      steps: exercised ? [step] : [],
      blockers: [exercised ? blocker : { ...blocker, step: null, notExercisedReason: reason }],
    });
    expect(result.ok).toBe(!exercised);
    expect(result.blockers[0]).toMatchObject({ status });
    expect(result.staleBlockers).toHaveLength(exercised ? 1 : 0);
    expect(renderMarkdownReport(result)).toContain(
      exercised ? "Delete this entry from expected-node-blockers.json." : reason,
    );
  });

  it("covers a path-qualified launcher only with a sentinel at that exact path", () => {
    const shellTrace = { ...trace, childPid: 15, cmd: ["sh", "-c", "/usr/local/bin/node -v"] };
    const ancestors = [{ pid: 15, cmdline: "sh" }];
    const masked = { ...sentinel, exe: "/usr/local/bin/node", argv: ["-v"], ancestors };
    expect(attribute([shellTrace], [masked])).toHaveLength(1);
    const elsewhere = { ...masked, exe: "/sentinels/node" };
    expect(attribute([shellTrace], [elsewhere])).toHaveLength(2);
  });

  it.each(["unrelated", "descendants", "exec"])(
    "attributes a shell stack to %s sentinels",
    (kind) => {
      const shellTrace = {
        ...trace,
        childPid: kind === "exec" ? trace.childPid : 15,
        cmd: [
          "/bin/sh",
          "-c",
          kind === "exec"
            ? "exec node --version"
            : kind === "descendants"
              ? "node -v; npm -v"
              : "node --version",
        ],
      };
      const ancestors = [
        { pid: 15, cmdline: "sh" },
        { pid: 10, cmdline: "bun" },
      ];
      const sentinels =
        kind === "descendants"
          ? [
              { ...sentinel, ppid: 15, argv: ["-v"], ancestors },
              { ...sentinel, pid: 21, ppid: 15, name: "npm", argv: ["-v"], ancestors },
            ]
          : [kind === "exec" ? { ...sentinel, argv: ["--version"] } : sentinel];
      const attempts = attribute([shellTrace], sentinels);
      if (kind === "unrelated") {
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({ sentinel, stack: [] });
        expect(attempts[0]).not.toHaveProperty("trace");
      } else {
        expect(attempts).toMatchObject(
          kind === "descendants"
            ? [
                { trace: shellTrace, sentinel: { name: "node" } },
                { trace: shellTrace, sentinel: { name: "npm" } },
              ]
            : [{ trace: shellTrace, stack: trace.stack, sentinel: { pid: trace.childPid } }],
        );
      }
    },
  );

  it.each([null, 99])("keeps a trace with child PID %s separate from the sentinel", (childPid) => {
    const attempts = attributeSpawns({
      traceRecords: [{ ...trace, childPid, errorCode: "ENOENT" }],
      sentinelRecords: [sentinel],
      steps: [step],
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ sentinel, stack: [] });
    expect(attempts[1]).toMatchObject({ trace: { childPid, errorCode: "ENOENT" } });
  });
});

describe("Bun spawn trace preload", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  function stubSpawnRuntime(spawn: (...args: unknown[]) => unknown) {
    const runtime = (
      globalThis as typeof globalThis & {
        Bun?: { spawn: typeof spawn; spawnSync: typeof spawn };
      }
    ).Bun;
    if (runtime) {
      vi.spyOn(runtime, "spawn").mockImplementation(spawn);
      vi.spyOn(runtime, "spawnSync").mockImplementation(spawn);
      return runtime;
    }
    const stub = { spawn, spawnSync: spawn };
    vi.stubGlobal("Bun", stub);
    return stub;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    ["spawn", false],
    ["spawnSync", false],
    ["spawn", true],
    ["spawnSync", true],
  ] as const)("records %s with failure=%s without changing its outcome", async (method, failed) => {
    const tracePath = path.join(tempDirs.make("bun-spawn-trace-"), "trace.jsonl");
    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    const child = { pid: 42 };
    const error = Object.assign(new Error("not found"), { code: "ENOENT" });
    const original = vi.fn(() => {
      if (failed) {
        throw error;
      }
      expect(existsSync(tracePath)).toBe(false);
      clock.mockReturnValue(200);
      return child;
    });
    const runtime = stubSpawnRuntime(original);
    vi.stubEnv("OPENCLAW_BUN_ONLY_SPAWN_TRACE", tracePath);
    vi.resetModules();
    await import("../../scripts/e2e/lib/bun-only-runtime/spawn-trace-preload.mjs");
    const cmd = failed
      ? ["node", "--version"]
      : ["/bin/sh", "-c", "/usr/bin/node --version; /opt/tools/npm --version"];
    const options = { cwd: "/smoke" };
    if (failed) {
      expect(() => Reflect.apply(runtime[method], runtime, [{ cmd }])).toThrow(error);
    } else {
      expect(Reflect.apply(runtime[method], runtime, [cmd, options])).toBe(child);
      expect(original).toHaveBeenCalledExactlyOnceWith(cmd, options);
      expect(original.mock.contexts).toEqual([runtime]);
    }
    expect(JSON.parse(readFileSync(tracePath, "utf8"))).toMatchObject(
      failed
        ? { childPid: null, errorCode: "ENOENT", cmd }
        : { childPid: 42, ts: 100, cmd, cwd: "/smoke", stack: expect.any(Array) },
    );
  });

  it("does not trace unrelated shell commands", async () => {
    const tracePath = path.join(tempDirs.make("bun-spawn-trace-"), "trace.jsonl");
    const runtime = stubSpawnRuntime(vi.fn(() => ({ pid: 7 })));
    vi.stubEnv("OPENCLAW_BUN_ONLY_SPAWN_TRACE", tracePath);
    vi.resetModules();
    await import("../../scripts/e2e/lib/bun-only-runtime/spawn-trace-preload.mjs");
    runtime.spawn(["/bin/sh", "-c", "echo nodejs-like && nodemon --help"]);
    expect(existsSync(tracePath)).toBe(false);
  });
});
