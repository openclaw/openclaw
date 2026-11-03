import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attributeSpawns,
  classifyNodeSpawns as classify,
  renderMarkdownReport as markdown,
} from "../../scripts/e2e/lib/bun-only-runtime/node-spawn-ledger.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const makeStep = (name = "terminals", index = 0, startMs = 100) => ({
  name,
  startMs,
  endMs: startMs + 100,
  sentinelStart: index,
  sentinelEnd: index + 1,
  status: "passed",
});
const step = makeStep();
const trace = {
  childPid: 20,
  pid: 10,
  ppid: 1,
  ts: 150,
  cmd: ["/sentinels/node", "--eval", 'const requiredFlag="";'],
  cwd: "/smoke",
  stack: ["at resolveNodeRuntimeExecutable", "at spawnNodeTerminalPty"],
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
type Classification = Parameters<typeof classify>[0];
const classifyWith = (overrides: Partial<Classification> = {}) =>
  classify({ attempts: attribute(), steps: [step], blockers: [blocker], ...overrides });

describe("Bun-only Node spawn ledger", () => {
  it.each(["unexpected", "matched", "stack mismatch", "argv mismatch", "failed step"])(
    "classifies %s spawns",
    (kind) => {
      const match =
        kind === "stack mismatch"
          ? { stack: ["differentOwner"] }
          : kind === "argv mismatch"
            ? { argv: ["--permission"] }
            : blocker.match;
      const result = classifyWith({
        steps: [kind === "failed step" ? { ...step, status: "failed", exitCode: 1 } : step],
        blockers: kind === "unexpected" ? [] : [{ ...blocker, match }],
      });
      expect(result.ok).toBe(kind === "matched");
      if (kind === "matched" || kind === "failed step") {
        expect(result.blockers[0]).toMatchObject({ status: "reproduced", reproducedBy: ["spawn"] });
        expect(markdown(result)).toContain(
          "| terminal-pty | known-blocker | reproduced | 1 | spawn |",
        );
      } else {
        expect(result.unexpectedAttempts).toHaveLength(1);
      }
      if (kind === "failed step") {
        expect(result.failedSteps).toHaveLength(1);
      }
      if (kind === "unexpected") {
        const report = markdown(result);
        expect(report).toContain(JSON.stringify(["node", ...sentinel.argv]));
        expect(report).toContain('ancestor 10: "bun openclaw.mjs gateway run"');
        expect(report).toContain("spawnNodeTerminalPty");
        expect(markdown({ ...result, bunVersion: "1", bunRevision: "rev" })).toContain(
          "Bun 1 (rev)",
        );
      }
    },
  );

  it("matches node-host spawns only in the same or later steps", () => {
    const steps = ["gateway", "node-host", "agent"].map((name, i) =>
      makeStep(name, i, 100 + i * 200),
    );
    const argv = ["view", "openclaw@latest"];
    const npm = {
      ...trace,
      cmd: ["npm", ...argv],
      stack: ["at fetchNpmPackageTargetStatus"],
    };
    const probe = { ...sentinel, name: "npm", argv: npm.cmd.slice(1) };
    const attempts = attributeSpawns({
      steps,
      traceRecords: [250, 450, 650].map((ts, i) =>
        Object.assign({}, npm, { childPid: 20 + i, ts }),
      ),
      sentinelRecords: [0, 1, 2].map((index) =>
        Object.assign({}, probe, { pid: 20 + index, index }),
      ),
    });
    expect(attempts.map((attempt) => attempt.step)).toEqual(["gateway", "node-host", "agent"]);
    const result = classifyWith({
      attempts,
      steps,
      blockers: [
        {
          ...blocker,
          step: "node-host",
          match: { stack: ["fetchNpmPackageTargetStatus"], argv },
        },
      ],
    });
    expect(result).toMatchObject({
      blockers: [{ matchedAttempts: attempts.slice(1) }],
      staleBlockers: [],
    });
    expect(result.unexpectedAttempts).toEqual([attempts[0]]);
  });

  it.each([{ evidence: "failure" }, { evidence: ["spawn", "failure"] }])(
    "matches cached failure evidence %j",
    ({ evidence }) => {
      const result = classifyWith({
        attempts: [],
        steps: [{ ...step, stderr: "Node required on Bun" }],
        blockers: [{ ...blocker, evidence, failure: "Node required" }],
      });
      expect(result).toMatchObject({
        ok: true,
        blockers: [{ status: "reproduced", reproducedBy: ["failure"] }],
      });
      if (evidence === "failure") {
        const withSpawn = classify({ ...result, attempts: attribute() });
        expect(withSpawn.unexpectedAttempts).toHaveLength(1);
      }
    },
  );

  it.each(["stale", "not-exercised"])("reports a %s blocker without spawn evidence", (status) => {
    const exercised = status === "stale";
    const reason = "Desktop provider is not enabled.";
    const result = classifyWith({
      attempts: [],
      steps: exercised ? [step] : [],
      blockers: [exercised ? blocker : { ...blocker, step: null, notExercisedReason: reason }],
    });
    expect(result).toMatchObject({ ok: !exercised, blockers: [{ status }] });
    expect(result.staleBlockers).toHaveLength(exercised ? 1 : 0);
    expect(markdown(result)).toContain(
      exercised ? "Delete this entry from expected-node-blockers.json." : reason,
    );
  });

  it("matches path-qualified launchers at the exact sentinel path", () => {
    const shellTrace = { ...trace, childPid: 15, cmd: ["sh", "-c", "/usr/local/bin/node -v"] };
    const ancestors = [{ pid: 15, cmdline: "sh" }];
    const masked = { ...sentinel, exe: "/usr/local/bin/node", argv: ["-v"], ancestors };
    expect(attribute([shellTrace], [masked])).toHaveLength(1);
    const elsewhere = { ...masked, exe: "/sentinels/node" };
    expect(attribute([shellTrace], [elsewhere])).toHaveLength(2);
  });

  it.each([
    ["unrelated", "node --version"],
    ["descendants", "node -v; npm -v"],
    ["exec", "exec node --version"],
  ])("attributes %s shell stacks", (kind, command) => {
    const shellTrace = {
      ...trace,
      childPid: kind === "exec" ? trace.childPid : 15,
      cmd: ["/bin/sh", "-c", command],
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
      expect(attempts).toMatchObject([{ sentinel, stack: [] }]);
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
  });

  it.each([null, 99])("keeps a trace with child PID %s separate from the sentinel", (childPid) => {
    const attempts = attribute([{ ...trace, childPid, errorCode: "ENOENT" }]);
    expect(attempts).toMatchObject([
      { sentinel, stack: [] },
      { trace: { childPid, errorCode: "ENOENT" } },
    ]);
  });
});

describe("Bun spawn trace preload", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  async function preload(spawn: (...args: unknown[]) => unknown) {
    const tracePath = path.join(tempDirs.make("bun-spawn-trace-"), "trace.jsonl");
    let runtime = (
      globalThis as typeof globalThis & {
        Bun?: { spawn: typeof spawn; spawnSync: typeof spawn };
      }
    ).Bun;
    if (runtime) {
      for (const method of ["spawn", "spawnSync"] as const) {
        vi.spyOn(runtime, method).mockImplementation(spawn);
      }
    } else {
      runtime = { spawn, spawnSync: spawn };
      vi.stubGlobal("Bun", runtime);
    }
    vi.stubEnv("OPENCLAW_BUN_ONLY_SPAWN_TRACE", tracePath);
    vi.resetModules();
    await import("../../scripts/e2e/lib/bun-only-runtime/spawn-trace-preload.mjs");
    return { tracePath, runtime };
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
    const { tracePath, runtime } = await preload(original);
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
    const { tracePath, runtime } = await preload(vi.fn(() => ({ pid: 7 })));
    runtime.spawn(["/bin/sh", "-c", "echo nodejs-like && nodemon --help"]);
    expect(existsSync(tracePath)).toBe(false);
  });
});
