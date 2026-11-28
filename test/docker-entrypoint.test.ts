import fs from "node:fs";
import path from "node:path";
import { describe, expect } from "vitest";
import { collectPackageRootModules } from "../scripts/lib/package-root-modules.mts";
import { createCommandTest, type CommandFixture } from "./helpers/command-fixture.js";

const it = createCommandTest();
const nodePath = `${path.dirname(process.execPath)}:/usr/bin:/bin`;

function fixture(command: CommandFixture) {
  const root = command.createTempDir("docker-activation-");
  for (const file of collectPackageRootModules(["docker-entrypoint.mjs"])) {
    fs.copyFileSync(path.resolve(file), path.join(root, file));
  }
  fs.mkdirSync(path.join(root, "dist"));
  const cli = String.raw`#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RECORD, JSON.stringify({args})+'\n');
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
    { args: ["openclaw.mjs", "gateway"] },
    { args: ["openclaw", "gateway"], installed: true },
    { args: ["dist/index.js", "gateway", "--bind", "lan", "--port", "18789"] },
  ])("execs the command directly: $args", async ({ args, installed }, { command }) => {
    const f = fixture(command);
    if (installed) {
      fs.symlinkSync("openclaw.mjs", path.join(f.root, "openclaw"));
    }
    const result = installed
      ? await f.runCommand(args, { PATH: `${f.root}:${nodePath}` })
      : await f.run(args);
    expect(result, result.stderr).toMatchObject({ status: 0, signal: null, error: undefined });
    const rows = f.read();
    expect(rows.map((row) => row.args)).toEqual([args.slice(1)]);
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
});
