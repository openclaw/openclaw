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
  it("fails an unexpected attempt and reports decoded ancestry and app frames", () => {
    const result = classifyNodeSpawns({ attempts: attribute(), steps: [step], blockers: [] });
    expect(result.ok).toBe(false);
    expect(result.unexpectedAttempts).toHaveLength(1);
    expect(renderMarkdownReport(result)).toContain(JSON.stringify(["node", ...sentinel.argv]));
    expect(renderMarkdownReport(result)).toContain('ancestor 10: "bun openclaw.mjs gateway run"');
    expect(result.attempts).toMatchObject([{ ancestors: sentinel.ancestors }]);
    expect(renderMarkdownReport(result)).toContain("spawnNodeTerminalPty");
    expect(
      renderMarkdownReport({ ...result, bunVersion: "1.4.3", bunRevision: "test-revision" }),
    ).toContain("Bun 1.4.3 (test-revision)");
  });

  it("reproduces a blocker only when all stack names and argv constraints match", () => {
    const attempts = attribute();
    const result = classifyNodeSpawns({ attempts, steps: [step], blockers: [blocker] });
    expect(result.ok).toBe(true);
    expect(result.blockers[0]).toMatchObject({ status: "reproduced", reproducedBy: ["spawn"] });
    expect(renderMarkdownReport(result)).toContain(
      "| terminal-pty | known-blocker | reproduced | 1 | spawn |",
    );
    for (const match of [{ stack: ["differentOwner"] }, { argv: ["--permission"] }]) {
      const mismatch = classifyNodeSpawns({
        attempts,
        steps: [step],
        blockers: [{ ...blocker, match }],
      });
      expect(mismatch.ok).toBe(false);
      expect(mismatch.unexpectedAttempts).toHaveLength(1);
    }
  });

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

  it("keeps the stack when a trace and its sentinel straddle a step boundary", () => {
    const steps = [
      { ...step, name: "node-host", startMs: 100, sentinelStart: 0 },
      { ...step, name: "agent", startMs: 200, sentinelStart: 0 },
    ];
    const [attempt, ...rest] = attributeSpawns({
      steps,
      traceRecords: [{ ...trace, ts: 150 }],
      sentinelRecords: [{ ...sentinel, index: 0 }],
    });
    expect(rest).toEqual([]);
    expect(attempt).toMatchObject({ step: "agent", stack: trace.stack });
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

  it("fails stale blockers and asks for their deletion", () => {
    const result = classifyNodeSpawns({ attempts: [], steps: [step], blockers: [blocker] });
    expect(result.ok).toBe(false);
    expect(result.staleBlockers).toHaveLength(1);
    expect(renderMarkdownReport(result)).toContain(
      "Delete this entry from expected-node-blockers.json.",
    );
  });

  it("reports blockers without an exercised step and preserves the reason", () => {
    const result = classifyNodeSpawns({
      attempts: [],
      steps: [],
      blockers: [
        { ...blocker, step: null, notExercisedReason: "Desktop provider is not enabled." },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.blockers[0]).toMatchObject({ status: "not-exercised" });
    expect(renderMarkdownReport(result)).toContain("Desktop provider is not enabled.");
  });

  it("attributes shell-wrapped spawns through ancestors and retains unmatched absolute attempts", () => {
    const traces = [
      { ...trace, childPid: 15, cmd: ["/bin/sh", "-c", "node --version"] },
      { ...trace, childPid: null, errorCode: "ENOENT", cmd: ["/usr/bin/node", "--version"] },
    ];
    const attempts = attribute(traces, [
      {
        ...sentinel,
        ppid: 15,
        argv: ["--version"],
        ancestors: [
          { pid: 15, cmdline: "sh" },
          { pid: 10, cmdline: "bun" },
        ],
      },
    ]);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ step: "terminals", trace: traces[0] });
    expect(attempts[1]).toMatchObject({ step: "terminals", argv: ["/usr/bin/node", "--version"] });
    expect(attempts[1]).not.toHaveProperty("sentinel");
  });

  it("does not treat launcher text in a shell script as an execution", () => {
    const shellTrace = { ...trace, childPid: 15, cmd: ["/bin/sh", "-c", "command -v node"] };
    expect(attribute([shellTrace], [])).toEqual([]);
  });

  it.each([
    ["/opt/node/bin/node --version || true"],
    ['cd /tmp && "/opt/node/bin/node" x'],
    ["for i in 1 2; do node -v; done; /opt/node/bin/node --version"],
    ["/opt/node/bin/node>/dev/null 2>&1 || true"],
    ["2>/dev/null </dev/null /opt/node/bin/node -v"],
  ])("reports an absent path-qualified launcher in shell script %j", (script) => {
    const shellTrace = { ...trace, childPid: 15, cmd: ["/bin/sh", "-c", script] };
    const ancestors = [{ pid: 15, cmdline: "sh" }];
    const loopSentinels = script.startsWith("for")
      ? [
          { ...sentinel, exe: "/sentinels/node", argv: ["-v"], ancestors },
          { ...sentinel, pid: 21, exe: "/sentinels/node", argv: ["-v"], ancestors },
        ]
      : [];
    const attempts = attribute([shellTrace], loopSentinels);
    expect(attempts.filter((attempt) => attempt.shellPath)).toEqual([
      expect.objectContaining({ argv: ["/opt/node/bin/node"], stack: trace.stack }),
    ]);
    const result = classifyNodeSpawns({ attempts, steps: [step], blockers: [] });
    expect(result.ok).toBe(false);
  });

  it("finds a path-qualified launcher in any shell argument", () => {
    const shellTrace = {
      ...trace,
      childPid: 15,
      cmd: ["bash", "-c", "-e", "/opt/node/bin/node --version"],
    };
    expect(attribute([shellTrace], [])).toMatchObject([{ argv: ["/opt/node/bin/node"] }]);
  });

  it("covers a path-qualified launcher only with a sentinel at that exact path", () => {
    const shellTrace = { ...trace, childPid: 15, cmd: ["sh", "-c", "/usr/local/bin/node -v"] };
    const ancestors = [{ pid: 15, cmdline: "sh" }];
    const masked = { ...sentinel, exe: "/usr/local/bin/node", argv: ["-v"], ancestors };
    expect(attribute([shellTrace], [masked])).toHaveLength(1);
    const elsewhere = { ...masked, exe: "/sentinels/node" };
    expect(attribute([shellTrace], [elsewhere])).toHaveLength(2);
  });

  it("ignores lookalikes and bare lookups in shell scripts", () => {
    const shellTrace = {
      ...trace,
      childPid: 15,
      cmd: ["sh", "-c", "command -v node; which npm; /usr/bin/nodemon; node_modules/.bin/tool"],
    };
    expect(attribute([shellTrace], [])).toEqual([]);
  });

  it("does not lend a shell stack to an unrelated sentinel under the same Bun parent", () => {
    const shellTrace = { ...trace, childPid: 15, cmd: ["/bin/sh", "-c", "node --version"] };
    const attempts = attribute([shellTrace]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ sentinel, stack: [] });
    expect(attempts[0]).not.toHaveProperty("trace");
  });

  it("lets one shell trace explain multiple descendants of that shell", () => {
    const shellTrace = { ...trace, childPid: 15, cmd: ["sh", "-c", "node -v; npm -v"] };
    const ancestors = [
      { pid: 15, cmdline: "sh" },
      { pid: 10, cmdline: "bun" },
    ];
    const attempts = attribute(
      [shellTrace],
      [
        { ...sentinel, ppid: 15, argv: ["-v"], ancestors },
        { ...sentinel, pid: 21, ppid: 15, name: "npm", argv: ["-v"], ancestors },
      ],
    );
    expect(attempts).toMatchObject([
      { trace: shellTrace, sentinel: { name: "node" } },
      { trace: shellTrace, sentinel: { name: "npm" } },
    ]);
  });

  it("explains a sentinel that the shell exec'd in place", () => {
    const shellTrace = { ...trace, cmd: ["/bin/sh", "-c", "exec node --version"] };
    const attempts = attribute([shellTrace], [{ ...sentinel, argv: ["--version"] }]);
    expect(attempts).toMatchObject([
      { trace: shellTrace, stack: trace.stack, sentinel: { pid: trace.childPid } },
    ]);
  });

  it.each([null, undefined, 99])(
    "keeps a trace with child PID %s separate from the sentinel",
    (childPid) => {
      const attempts = attributeSpawns({
        traceRecords: [{ ...trace, childPid, errorCode: "ENOENT" }],
        sentinelRecords: [sentinel],
        steps: [step],
      });
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toMatchObject({ sentinel, stack: [] });
      expect(attempts[1]).toMatchObject({ trace: { childPid, errorCode: "ENOENT" } });
    },
  );

  it("does not allow one direct trace to erase a second sentinel attempt", () => {
    const attempts = attributeSpawns({
      traceRecords: [trace],
      sentinelRecords: [sentinel, { ...sentinel, pid: 21 }],
      steps: [{ ...step, sentinelEnd: 2 }],
    });
    const result = classifyNodeSpawns({ attempts, steps: [step], blockers: [blocker] });
    expect(result.ok).toBe(false);
    expect(result.unexpectedAttempts).toHaveLength(1);
    expect(result.unexpectedAttempts[0]).toMatchObject({ pid: 21 });
  });

  it("keeps an independently failed step failed even when its blocker reproduced", () => {
    const result = classifyNodeSpawns({
      attempts: attribute(),
      steps: [{ ...step, status: "failed", exitCode: 1 }],
      blockers: [blocker],
    });
    expect(result.ok).toBe(false);
    expect(result.failedSteps).toHaveLength(1);
  });

  it("loads a blocker inventory with accountable identities", () => {
    const inventory = JSON.parse(
      readFileSync(
        new URL(
          "../../scripts/e2e/lib/bun-only-runtime/expected-node-blockers.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(Array.isArray(inventory.blockers)).toBe(true);
    for (const entry of inventory.blockers) {
      expect(["known-blocker", "found-by-lane"]).toContain(entry.origin);
      for (const key of ["id", "feature", "owner", "callSite"]) {
        expect(entry[key], `${entry.id}: ${key}`).toEqual(expect.any(String));
        expect(entry[key].trim().length).toBeGreaterThan(0);
      }
    }
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

  it.each(["spawn", "spawnSync"] as const)(
    "records %s child PID after spawning, with the pre-call timestamp and unchanged result",
    async (method) => {
      const tracePath = path.join(tempDirs.make("bun-spawn-trace-"), "trace.jsonl");
      const clock = vi.spyOn(Date, "now").mockReturnValue(100);
      const child = { pid: 42 };
      const original = vi.fn(() => {
        expect(existsSync(tracePath)).toBe(false);
        clock.mockReturnValue(200);
        return child;
      });
      const runtime = stubSpawnRuntime(original);
      vi.stubEnv("OPENCLAW_BUN_ONLY_SPAWN_TRACE", tracePath);
      vi.resetModules();
      await import("../../scripts/e2e/lib/bun-only-runtime/spawn-trace-preload.mjs");
      const cmd = ["/bin/sh", "-c", "/usr/bin/node --version; /opt/tools/npm --version"];
      const options = { cwd: "/smoke" };
      expect(Reflect.apply(runtime[method], runtime, [cmd, options])).toBe(child);
      expect(original).toHaveBeenCalledExactlyOnceWith(cmd, options);
      expect(original.mock.contexts).toEqual([runtime]);
      expect(JSON.parse(readFileSync(tracePath, "utf8"))).toMatchObject({
        childPid: 42,
        ts: 100,
        cmd,
        cwd: "/smoke",
        stack: expect.any(Array),
      });
    },
  );

  it.each(["spawn", "spawnSync"] as const)(
    "records %s ENOENT without changing the thrown error",
    async (method) => {
      const tracePath = path.join(tempDirs.make("bun-spawn-trace-"), "trace.jsonl");
      const error = Object.assign(new Error("not found"), { code: "ENOENT" });
      const original = vi.fn(() => {
        throw error;
      });
      const runtime = stubSpawnRuntime(original);
      vi.stubEnv("OPENCLAW_BUN_ONLY_SPAWN_TRACE", tracePath);
      vi.resetModules();
      await import("../../scripts/e2e/lib/bun-only-runtime/spawn-trace-preload.mjs");
      expect(() =>
        Reflect.apply(runtime[method], runtime, [{ cmd: ["node", "--version"] }]),
      ).toThrow(error);
      expect(JSON.parse(readFileSync(tracePath, "utf8"))).toMatchObject({
        childPid: null,
        errorCode: "ENOENT",
        cmd: ["node", "--version"],
      });
    },
  );

  it.each([
    ['"/opt/node/bin/node" --version', true],
    ["exec '/usr/local/bin/npx' -y tool", true],
    ["cd /tmp && node -v", true],
    ["echo nodejs-like && nodemon --help", false],
  ])("traces shell script %j: %s", async (script, traced) => {
    const tracePath = path.join(tempDirs.make("bun-spawn-trace-"), "trace.jsonl");
    const runtime = stubSpawnRuntime(vi.fn(() => ({ pid: 7 })));
    vi.stubEnv("OPENCLAW_BUN_ONLY_SPAWN_TRACE", tracePath);
    vi.resetModules();
    await import("../../scripts/e2e/lib/bun-only-runtime/spawn-trace-preload.mjs");
    runtime.spawn(["/bin/sh", "-c", script]);
    expect(existsSync(tracePath)).toBe(traced);
  });
});
