import fs from "node:fs";
import path from "node:path";
import { describe, expect } from "vitest";
import { createCommandTest, type CommandFixture } from "./helpers/command-fixture.js";

const it = createCommandTest();
const nodePath = `${path.dirname(process.execPath)}:/usr/bin:/bin`;

function fixture(command: CommandFixture) {
  const root = command.createTempDir("docker-activation-");
  for (const file of ["docker-entrypoint.mjs", "gateway-run-argv.mjs", "cli-root-options.mjs"]) {
    fs.copyFileSync(path.resolve(file), path.join(root, file));
  }
  fs.mkdirSync(path.join(root, "dist"));
  const cli = String.raw`#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RECORD, JSON.stringify({args, pid:process.pid, parentPid:process.ppid, marker:process.env.OPENCLAW_IMAGE_ACTIVATION_CAPTURE_MARKER})+'\n');
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
        PATH: nodePath,
        HOME: root,
        TMPDIR: root,
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
    { args: ["openclaw", "gateway"], rootOptions: [], installed: true },
    { args: ["dist/index.js", "gateway", "--bind", "lan", "--port", "18789"], rootOptions: [] },
    {
      args: ["openclaw.mjs", "--profile", "demo", "gateway", "run", "--no-color"],
      rootOptions: ["--profile", "demo", "--no-color"],
    },
    { args: ["openclaw.mjs", "gateway", "--profile=demo"], rootOptions: ["--profile=demo"] },
    { args: ["openclaw.mjs", "--dev", "gateway"], rootOptions: ["--dev"] },
    { args: ["openclaw.mjs", "gateway", "--dev"], rootOptions: [] },
    { args: ["openclaw.mjs", "gateway", "--token", "--reset"], rootOptions: [] },
  ])("execs after Doctor: $args", async ({ args, rootOptions, installed }, { command }) => {
    const f = fixture(command);
    if (installed) {
      fs.symlinkSync("openclaw.mjs", path.join(f.root, "openclaw"));
    }
    const result = installed
      ? await f.runCommand(args, { PATH: `${f.root}:${nodePath}` })
      : await f.run(args);
    expect(result, result.stderr).toMatchObject({ status: 0, signal: null, error: undefined });
    const rows = f.read();
    expect(rows.map((row) => row.args)).toEqual([
      [...rootOptions, "doctor", "--fix", "--non-interactive"],
      args.slice(1),
    ]);
    expect(rows[1].pid).toBe(rows[0].parentPid);
  });

  it.for(
    [
      ["gateway", "--help"],
      ["--version"],
      ["doctor", "--fix"],
      ["gateway", "status"],
      ["gateway", "--dev", "--reset"],
      ["gateway", "--", "--profile", "literal"],
    ].map((args) => ({ args })),
  )("skips Doctor: $args", async ({ args }, { command }) => {
    const f = fixture(command);
    expect((await f.run(["openclaw.mjs", ...args])).status).toBe(0);
    expect(f.read().map((row) => row.args)).toEqual([args]);
  });

  it.for(["-0", "NAME=value"])(
    "treats %s as a command, not env syntax",
    async (name, { command }) => {
      const f = fixture(command);
      const result = await f.runCommand([name]);
      expect(result).toMatchObject({ status: 127, stdout: "" });
    },
  );

  it("skips directories in PATH", async ({ command }) => {
    const f = fixture(command);
    const first = path.join(f.root, "first");
    const second = path.join(f.root, "second");
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    fs.mkdirSync(path.join(first, "activation-command"));
    fs.symlinkSync(process.execPath, path.join(second, "activation-command"));
    const args = ["activation-command", "-e", "process.stdout.write('unchanged')"];
    const result = await f.runCommand(args, { PATH: `${first}:${second}` });
    expect(result).toMatchObject({ status: 0, stdout: "unchanged", error: undefined });
  });

  it.for([
    { signal: undefined, forwarded: undefined, status: 78 },
    { signal: "SIGTERM", forwarded: "SIGTERM", status: 143 },
    { signal: "SIGINT", forwarded: "SIGINT", status: 130 },
    { signal: "SIGHUP", forwarded: "SIGTERM", status: 129 },
    { signal: "SIGQUIT", forwarded: "SIGTERM", status: 131 },
  ])("stops after Doctor exits $status", async ({ signal, forwarded, status }, { command }) => {
    const f = fixture(command);
    const env: Record<string, string> = signal
      ? { INTERRUPT_DOCTOR: signal }
      : { DOCTOR_EXIT: "78" };
    expect((await f.run(["openclaw.mjs", "gateway"], env)).status).toBe(status);
    expect(f.read().map(({ args, ...event }) => args ?? event)).toEqual([
      ["doctor", "--fix", "--non-interactive"],
      ...(forwarded ? [{ stopped: true, signal: forwarded }] : []),
    ]);
  });

  it("scopes Doctor capture markers to the activation", async ({ command }) => {
    const f = fixture(command);
    // An inherited path never replaces the marker this container's activation owns.
    const inherited = { OPENCLAW_IMAGE_ACTIVATION_CAPTURE_MARKER: "/elsewhere/marker" };
    expect((await f.run(["openclaw.mjs", "gateway"], inherited)).status).toBe(0);
    expect((await f.run(["openclaw.mjs", "gateway"])).status).toBe(0);
    expect((await f.run(["openclaw.mjs", "--profile", "demo", "gateway"])).status).toBe(0);
    const rows = f.read();
    const markers = rows.filter((row) => row.args.includes("doctor")).map((row) => row.marker);
    expect(markers).toHaveLength(3);
    for (const marker of markers) {
      expect(path.dirname(marker)).toBe(f.root);
    }
    expect(markers[1]).toBe(markers[0]);
    expect(markers[2]).not.toBe(markers[0]);
    // Doctor owns the marker; the activation adapter never creates it.
    expect(fs.existsSync(markers[0])).toBe(false);
    expect(rows.filter((row) => !row.args.includes("doctor")).map((row) => row.marker)).toEqual([
      "/elsewhere/marker",
      undefined,
      undefined,
    ]);
  });
});
