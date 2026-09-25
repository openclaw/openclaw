import fs from "node:fs";
import path from "node:path";
import { describe, expect } from "vitest";
import { createCommandTest, type CommandFixture } from "./helpers/command-fixture.js";

const it = createCommandTest();

function fixture(command: CommandFixture) {
  const root = command.createTempDir("docker-activation-");
  for (const file of ["docker-entrypoint.mjs", "gateway-run-argv.mjs", "cli-root-options.mjs"]) {
    fs.copyFileSync(path.resolve(file), path.join(root, file));
  }
  fs.mkdirSync(path.join(root, "dist"));
  const cli = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RECORD, JSON.stringify({args, pid:process.pid, parentPid:process.ppid})+'\n');
if (args.includes('doctor')) {
  if (process.env.INTERRUPT_DOCTOR) {
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.on(signal, () => setImmediate(() => {
        fs.appendFileSync(process.env.RECORD, JSON.stringify({stopped:true, signal})+'\n');
        process.exit(0);
      }));
    }
    setInterval(() => {}, 1000);
    process.kill(process.ppid, process.env.INTERRUPT_DOCTOR);
  } else process.exit(Number(process.env.DOCTOR_EXIT || 0));
}
`;
  fs.writeFileSync(path.join(root, "openclaw.mjs"), cli, { mode: 0o755 });
  fs.writeFileSync(path.join(root, "dist/index.js"), cli);
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  const record = path.join(root, "calls.jsonl");
  const runCommand = (argv: string[], env: Record<string, string> = {}) =>
    command.run(process.execPath, [path.join(root, "docker-entrypoint.mjs"), ...argv], {
      cwd: root,
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: root,
        RECORD: record,
        ...env,
      },
      timeout: 10000,
    });
  return {
    root,
    read: () =>
      fs
        .readFileSync(record, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    runCommand,
    run: (args: string[], env: Record<string, string> = {}) =>
      runCommand([process.execPath, ...args], env),
  };
}

describe.skipIf(process.platform === "win32")("Docker image activation", () => {
  it.for([
    { args: ["openclaw.mjs", "gateway"], rootOptions: [] },
    { args: ["dist/index.js", "gateway", "--bind", "lan", "--port", "18789"], rootOptions: [] },
    {
      args: ["openclaw.mjs", "--profile", "demo", "gateway", "run", "--no-color"],
      rootOptions: ["--profile", "demo", "--no-color"],
    },
    { args: ["openclaw.mjs", "gateway", "--profile=demo"], rootOptions: ["--profile=demo"] },
    { args: ["openclaw.mjs", "--dev", "gateway"], rootOptions: ["--dev"] },
    { args: ["openclaw.mjs", "gateway", "--dev"], rootOptions: [] },
    { args: ["openclaw.mjs", "gateway", "--token", "--reset"], rootOptions: [] },
    { args: ["openclaw.mjs", "gateway", "--token", "--profile=token-value"], rootOptions: [] },
  ])(
    "settles Doctor then execs the original command: $args",
    async ({ args, rootOptions }, { command }) => {
      const f = fixture(command);
      const result = await f.run(args);
      expect(result, result.stderr).toMatchObject({ status: 0, signal: null, error: undefined });
      const rows = f.read();
      expect(rows.map((row) => row.args)).toEqual([
        [...rootOptions, "doctor", "--fix", "--non-interactive"],
        args.slice(1),
      ]);
      expect(rows[1].pid).toBe(rows[0].parentPid);
    },
  );

  it("repairs before the image's installed openclaw command", async ({ command }) => {
    const f = fixture(command);
    fs.symlinkSync("openclaw.mjs", path.join(f.root, "openclaw"));
    const result = await f.runCommand(["openclaw", "gateway"], {
      PATH: `${f.root}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    });
    expect(result, result.stderr).toMatchObject({ status: 0, signal: null, error: undefined });
    const rows = f.read();
    expect(rows.map((row) => row.args)).toEqual([
      ["doctor", "--fix", "--non-interactive"],
      ["gateway"],
    ]);
    expect(rows[1].pid).toBe(rows[0].parentPid);
  });

  it.for(
    [
      ["gateway", "--help"],
      ["--help"],
      ["--version"],
      ["doctor", "--fix"],
      ["gateway", "status"],
      ["config", "get", "gateway.mode"],
      ["gateway", "--dev", "--reset"],
      ["gateway", "--", "--profile", "literal"],
      ["gateway", "--unknown-option"],
    ].map((args) => ({ args })),
  )("passes through without an activation repair: $args", async ({ args }, { command }) => {
    const f = fixture(command);
    expect((await f.run(["openclaw.mjs", ...args])).status).toBe(0);
    expect(f.read().map((row) => row.args)).toEqual([args]);
  });

  it.for(["-0", "NAME=value"])(
    "does not interpret an arbitrary command as env syntax: %s",
    async (name, { command }) => {
      const f = fixture(command);
      const result = await f.runCommand([name]);
      expect(result.status).toBe(127);
      expect(result.stdout).toBe("");
    },
  );

  it("skips a PATH directory and executes the original arbitrary command", async ({ command }) => {
    const f = fixture(command);
    const first = path.join(f.root, "first");
    const second = path.join(f.root, "second");
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    fs.mkdirSync(path.join(first, "activation-command"));
    fs.symlinkSync(process.execPath, path.join(second, "activation-command"));
    const result = await f.runCommand(
      ["activation-command", "-e", "process.stdout.write('unchanged')"],
      {
        PATH: `${first}:${second}`,
      },
    );
    expect(result).toMatchObject({ status: 0, stdout: "unchanged", error: undefined });
  });

  it("does not start Gateway after Doctor refuses repair", async ({ command }) => {
    const f = fixture(command);
    expect((await f.run(["openclaw.mjs", "gateway"], { DOCTOR_EXIT: "78" })).status).toBe(78);
    expect(f.read()).toHaveLength(1);
  });

  it.for([
    { signal: "SIGTERM", forwarded: "SIGTERM", status: 143 },
    { signal: "SIGINT", forwarded: "SIGINT", status: 130 },
    { signal: "SIGHUP", forwarded: "SIGTERM", status: 129 },
    { signal: "SIGQUIT", forwarded: "SIGTERM", status: 131 },
  ])(
    "joins Doctor after $signal even when it exits successfully, without starting Gateway",
    async ({ signal, forwarded, status }, { command }) => {
      const f = fixture(command);
      expect((await f.run(["openclaw.mjs", "gateway"], { INTERRUPT_DOCTOR: signal })).status).toBe(
        status,
      );
      expect(f.read()).toEqual([
        {
          args: ["doctor", "--fix", "--non-interactive"],
          pid: expect.any(Number),
          parentPid: expect.any(Number),
        },
        { stopped: true, signal: forwarded },
      ]);
    },
  );
});
