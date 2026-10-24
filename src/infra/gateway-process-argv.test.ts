import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { classifyOpenClawArgv, parseProcCmdline } from "./gateway-process-argv.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type Options = NonNullable<Parameters<typeof classifyOpenClawArgv>[1]>;
function expectKind(argv: string[], kind: string, opts: Options = {}) {
  expect(classifyOpenClawArgv(argv, opts).kind).toBe(kind);
}
function expectEntry(argv: string[], entryIndex?: number, opts: Options = {}) {
  expect(classifyOpenClawArgv(argv, opts)).toEqual(
    entryIndex === undefined ? { kind: "other" } : { kind: "openclaw", entryIndex },
  );
}
function uncertain(argv: string[], cause: string, reason: string) {
  expect(classifyOpenClawArgv(argv)).toEqual({
    kind: "unclassified",
    cause,
    reason: expect.stringContaining(reason),
  });
}

function scriptFixture(entry: string, packageName = "openclaw") {
  const root = tempDirs.make("process-argv-");
  const script = path.join(root, entry);
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: packageName }));
  return { root, script };
}

it("parses proc arguments without retaining empty entries", () => {
  expect(
    [" node \0 gateway \0\0 --port \0 18789 \0", " gateway ", " \0\t\0 "].map(parseProcCmdline),
  ).toStrictEqual([["node", "gateway", "--port", "18789"], ["gateway"], []]);
});

it("classifies executable identities and the requested command, excluding argument values", () => {
  const built = scriptFixture("dist/entry.js");
  const cases: Array<[string[], string | undefined, "openclaw" | "other"]> = [
    ...["NODE", "bun", "tsx"].flatMap((runtime): typeof cases => [
      [[runtime, built.script, "GATEWAY"], "gateway", "openclaw"],
      [[runtime, built.script, "doctor"], "gateway", "other"],
    ]),
    [["node", built.script, "doctor"], "doctor", "openclaw"],
    [["python", "doctor", "worker.py"], "doctor", "other"],
    [["C:\\bin\\openclaw.cmd", "gateway"], "gateway", "openclaw"],
    [["/usr/local/bin/openclaw-gateway"], "gateway", "openclaw"],
    [["C:\\bin\\openclaw-gateway.EXE"], "gateway", "openclaw"],
    [["openclaw-doctor"], "gateway", "other"],
    [["openclaw", "agent", "--message", "gateway"], "gateway", "other"],
    [["openclaw", "--profile", "gateway", "status"], "gateway", "other"],
    [["node", "/srv/openclaw/openclaw.mjs", "tui", "--local"], undefined, "openclaw"],
    [["openclaw"], undefined, "openclaw"],
    [["python", "worker.py"], undefined, "other"],
  ];
  for (const [argv, command, kind] of cases) {
    expectKind(argv, kind, { command });
  }
});

it("classifies the runtime script after flags and subcommands without adopting argument values", () => {
  const owned = scriptFixture("dist/index.js");
  const other = scriptFixture("app.js", "unrelated-service");
  const source = scriptFixture("src/index.ts");
  const namedRun = scriptFixture("run", "unrelated-service");
  const cases: Array<[string[], number | undefined]> = [
    ...["--inspect", "--inspect-brk", "--inspect-wait", "--expose-gc"].map(
      (flag): [string[], number] => [["node", flag, owned.script, "gateway"], 2],
    ),
    [["tsx", "watch", source.script, "gateway"], 2],
    ...["--watch", "--hot", "--no-install"].map((flag): [string[], number] => [
      ["bun", flag, "run", owned.script, "gateway"],
      3,
    ]),
    [["node", "--import", owned.script, other.script, owned.script], undefined],
    [["node", "--eval", "0", owned.script], undefined],
    [["node", other.script, "/opt/openclaw/openclaw.mjs"], undefined],
    [["node", "--import", "loader.js", "--no-warnings", owned.script], 4],
    [["node", "--trace-uncaught", owned.script], 2],
    [["node", "--cpu-prof-name", owned.script, other.script], undefined],
    [["bun", "run", "run", owned.script], undefined],
  ];
  for (const [argv, entryIndex] of cases) {
    expectEntry(argv, entryIndex, { cwd: namedRun.root });
  }
  for (const runtime of ["node", "bun"]) {
    expect(classifyOpenClawArgv([runtime, "--unknown-option", owned.script, "gateway"])).toEqual({
      kind: "unclassified",
      cause: "runtime-syntax",
      reason: "unsupported runtime option --unknown-option",
    });
  }
});

it("uses package identity for built, source, launcher, and registered worker entrypoints", () => {
  for (const entry of [
    "dist/index.js",
    "dist/entry.js",
    "src/entry.ts",
    "src/index.ts",
    "scripts/run-node.mjs",
    "dist/infra/example.worker.js",
  ]) {
    const owned = scriptFixture(entry);
    const other = scriptFixture(entry, "unrelated-service");
    const additionalEntrypoints = entry.endsWith(".worker.js") ? [entry] : undefined;
    expectEntry(["node", entry], 1, { cwd: owned.root, additionalEntrypoints });
    expectEntry(["node", entry], undefined, { cwd: other.root, additionalEntrypoints });
    expectEntry(["node", other.script, "gateway"], undefined, {
      command: "gateway",
      additionalEntrypoints,
    });
  }
});

it("uses the resolved entrypoint for relative spellings and launcher targets", () => {
  const owned = scriptFixture("dist/index.js");
  for (const [script, cwd] of [
    ["index.js", path.dirname(owned.script)],
    ["./dist//index.js", owned.root],
  ] as const) {
    expectKind(["node", script], "openclaw", { cwd });
  }
  const launcher = scriptFixture("openclaw.mjs");
  const resolved = vi.spyOn(fs, "realpathSync").mockReturnValue(launcher.script);
  try {
    expectKind(["node", path.join(launcher.root, "dist/index.js")], "openclaw");
  } finally {
    resolved.mockRestore();
  }
});

it("preserves uncertainty when cwd, script, or package identity cannot be inspected", () => {
  const owned = scriptFixture("dist/index.js");
  uncertain(["node", "dist/index.js"], "cwd", "working directory");
  const manifest = path.join(owned.root, "package.json");
  for (const contents of ["{", undefined]) {
    if (contents === undefined) {
      fs.unlinkSync(manifest);
    } else {
      fs.writeFileSync(manifest, contents);
    }
    uncertain(["node", owned.script], "package-identity", "package identity");
  }
  fs.unlinkSync(owned.script);
  uncertain(["node", owned.script], "script", "resolve script");
  expectKind(["node", owned.script, "gateway"], "unclassified", { command: "gateway" });
});

it("rejects foreign standalone scripts even without a package identity", () => {
  const other = scriptFixture("service.js", "unrelated-service");
  fs.unlinkSync(path.join(other.root, "package.json"));
  for (const command of [undefined, "gateway"]) {
    expectEntry(["node", other.script], undefined, { command });
  }
});
