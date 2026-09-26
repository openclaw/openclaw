// Tests gateway process argv parsing for diagnostics.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { classifyOpenClawArgv, parseProcCmdline } from "./gateway-process-argv.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function scriptFixture(entry: string, packageName = "openclaw") {
  const root = tempDirs.make("process-argv-");
  const script = path.join(root, entry);
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: packageName }));
  return { root, script };
}

describe("parseProcCmdline", () => {
  it("splits null-delimited argv and trims empty entries", () => {
    expect(parseProcCmdline(" node \0 gateway \0\0 --port \0 18789 \0")).toEqual([
      "node",
      "gateway",
      "--port",
      "18789",
    ]);
  });

  it("keeps non-delimited single arguments and drops whitespace-only entries", () => {
    expect(parseProcCmdline(" gateway ")).toEqual(["gateway"]);
    expect(parseProcCmdline(" \0\t\0 ")).toStrictEqual([]);
  });
});

describe("command ownership", () => {
  it("requires the requested command after verifying the installation", () => {
    const built = scriptFixture("dist/entry.js");
    for (const runtime of ["NODE", "bun", "tsx"]) {
      expect(
        classifyOpenClawArgv([runtime, built.script, "GATEWAY"], { command: "gateway" }).kind,
      ).toBe("openclaw");
      expect(
        classifyOpenClawArgv([runtime, built.script, "doctor"], { command: "gateway" }).kind,
      ).toBe("other");
    }
    expect(classifyOpenClawArgv(["node", built.script, "doctor"], { command: "doctor" }).kind).toBe(
      "openclaw",
    );
    expect(
      classifyOpenClawArgv(["python", "doctor", "worker.py"], { command: "doctor" }).kind,
    ).toBe("other");
  });

  it("recognizes specific CLI and retitled command identities", () => {
    expect(
      classifyOpenClawArgv(["C:\\bin\\openclaw.cmd", "gateway"], { command: "gateway" }).kind,
    ).toBe("openclaw");
    expect(
      classifyOpenClawArgv(["/usr/local/bin/openclaw-gateway"], { command: "gateway" }).kind,
    ).toBe("openclaw");
    expect(
      classifyOpenClawArgv(["C:\\bin\\openclaw-gateway.EXE"], { command: "gateway" }).kind,
    ).toBe("openclaw");
    expect(classifyOpenClawArgv(["openclaw-doctor"], { command: "gateway" }).kind).toBe("other");
  });

  it("does not mistake application arguments or root-option values for the command", () => {
    for (const argv of [
      ["openclaw", "agent", "--message", "gateway"],
      ["openclaw", "--profile", "gateway", "status"],
    ]) {
      expect(classifyOpenClawArgv(argv, { command: "gateway" }).kind).toBe("other");
    }
  });
});

describe("OpenClaw process owners", () => {
  it.each([
    ["agent exec", ["openclaw", "agent", "exec", "task"]],
    ["local TUI", ["node", "/srv/openclaw/openclaw.mjs", "tui", "--local"]],
    ["models probe", ["openclaw", "models", "status", "--probe"]],
    ["bare local TUI", ["openclaw"]],
  ])("recognizes the %s embedded owner", (_label, argv) => {
    expect(classifyOpenClawArgv(argv).kind).toBe("openclaw");
  });

  it("rejects an unrelated process", () => {
    expect(classifyOpenClawArgv(["python", "worker.py"]).kind).toBe("other");
  });
});

describe("classifyOpenClawArgv", () => {
  it.each(["--inspect", "--inspect-brk", "--inspect-wait", "--expose-gc"])(
    "keeps the script after the boolean %s option",
    (flag) => {
      const owned = scriptFixture("dist/index.js");
      expect(classifyOpenClawArgv(["node", flag, owned.script, "gateway"]).kind).toBe("openclaw");
    },
  );
  it("resolves the script after the tsx watch subcommand", () => {
    const owned = scriptFixture("src/index.ts");
    expect(classifyOpenClawArgv(["tsx", "watch", owned.script, "gateway"]).kind).toBe("openclaw");
  });
  it("uses the resolved entrypoint when argv contains only its basename or extra separators", () => {
    const owned = scriptFixture("dist/index.js");
    expect(
      classifyOpenClawArgv(["node", "index.js"], { cwd: path.dirname(owned.script) }).kind,
    ).toBe("openclaw");
    expect(classifyOpenClawArgv(["node", "./dist//index.js"], { cwd: owned.root }).kind).toBe(
      "openclaw",
    );
  });

  it("verifies the package owning a resolved launcher target", () => {
    const owned = scriptFixture("openclaw.mjs");
    const resolved = vi.spyOn(fs, "realpathSync").mockReturnValue(owned.script);
    try {
      expect(classifyOpenClawArgv(["node", path.join(owned.root, "dist/index.js")]).kind).toBe(
        "openclaw",
      );
    } finally {
      resolved.mockRestore();
    }
  });

  it("recognizes Bun run after runtime flags without consuming a script named run twice", () => {
    const owned = scriptFixture("dist/index.js");
    const other = scriptFixture("run", "unrelated-service");
    expect(classifyOpenClawArgv(["bun", "--watch", "run", owned.script, "gateway"])).toEqual({
      kind: "openclaw",
      entryIndex: 3,
    });
    expect(classifyOpenClawArgv(["bun", "run", "run", owned.script], { cwd: other.root })).toEqual({
      kind: "other",
    });
  });

  it.each([
    "dist/index.js",
    "dist/entry.js",
    "src/entry.ts",
    "src/index.ts",
    "scripts/run-node.mjs",
  ])("distinguishes OpenClaw from an unrelated package using %s", (entry) => {
    const owned = scriptFixture(entry);
    const other = scriptFixture(entry, "unrelated-service");
    expect(classifyOpenClawArgv(["node", entry], { cwd: owned.root })).toEqual({
      kind: "openclaw",
      entryIndex: 1,
    });
    expect(classifyOpenClawArgv(["node", entry], { cwd: other.root })).toEqual({ kind: "other" });
    expect(
      classifyOpenClawArgv(["node", other.script, "gateway"], { command: "gateway" }).kind,
    ).toBe("other");
  });

  it("examines the runtime script, not eval source, option values or application arguments", () => {
    const owned = scriptFixture("dist/index.js");
    const other = scriptFixture("app.js", "unrelated-service");
    expect(
      classifyOpenClawArgv(["node", "--import", owned.script, other.script, owned.script]),
    ).toEqual({ kind: "other" });
    expect(classifyOpenClawArgv(["node", "--eval", "0", owned.script])).toEqual({ kind: "other" });
    expect(classifyOpenClawArgv(["node", other.script, "/opt/openclaw/openclaw.mjs"])).toEqual({
      kind: "other",
    });
    expect(
      classifyOpenClawArgv(["node", "--import", "loader.js", "--no-warnings", owned.script]),
    ).toEqual({ kind: "openclaw", entryIndex: 4 });
    expect(classifyOpenClawArgv(["node", "--trace-uncaught", owned.script])).toEqual({
      kind: "openclaw",
      entryIndex: 2,
    });
    expect(classifyOpenClawArgv(["node", "--cpu-prof-name", owned.script, other.script])).toEqual({
      kind: "other",
    });
  });

  it("retains an explicit unknown when the working directory or script cannot be inspected", () => {
    const owned = scriptFixture("dist/index.js");
    expect(classifyOpenClawArgv(["node", "dist/index.js"])).toEqual({
      kind: "unclassified",
      reason: expect.stringContaining("working directory"),
    });
    fs.unlinkSync(owned.script);
    expect(classifyOpenClawArgv(["node", owned.script])).toEqual({
      kind: "unclassified",
      reason: expect.stringContaining("resolve script"),
    });
    expect(
      classifyOpenClawArgv(["node", owned.script, "gateway"], { command: "gateway" }).kind,
    ).toBe("unclassified");
  });

  it("preserves uncertainty for an absent or unreadable package identity", () => {
    const owned = scriptFixture("dist/index.js");
    const manifest = path.join(owned.root, "package.json");
    fs.writeFileSync(manifest, "{");
    expect(classifyOpenClawArgv(["node", owned.script])).toEqual({
      kind: "unclassified",
      reason: expect.stringContaining("package identity"),
    });
    fs.unlinkSync(manifest);
    expect(classifyOpenClawArgv(["node", owned.script])).toEqual({
      kind: "unclassified",
      reason: expect.stringContaining("package identity"),
    });
  });

  it("uses the same package facts for registered worker entrypoints", () => {
    const entry = "dist/infra/example.worker.js";
    const owned = scriptFixture(entry);
    const other = scriptFixture(entry, "unrelated-service");
    const additionalEntrypoints = [entry];
    expect(classifyOpenClawArgv(["node", owned.script], { additionalEntrypoints })).toEqual({
      kind: "openclaw",
      entryIndex: 1,
    });
    expect(classifyOpenClawArgv(["node", other.script], { additionalEntrypoints })).toEqual({
      kind: "other",
    });
  });
});
