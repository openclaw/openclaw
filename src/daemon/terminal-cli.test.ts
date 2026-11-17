import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyCliProfileEnv, parseCliProfileArgs } from "../cli/profile.js";
import { installGatewayTerminalCli } from "./terminal-cli.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(profile = "default", shell = "/bin/bash") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-terminal-"));
  roots.push(root);
  const home = path.join(root, "home with '$ characters");
  await fs.mkdir(home);
  const entrypoint = path.join(root, "cli with ' quote.mjs");
  await fs.writeFile(
    entrypoint,
    'console.log(JSON.stringify({profile: process.env.OPENCLAW_PROFILE, args: process.argv.slice(2)})); process.exitCode = process.argv.includes("fail") ? 23 : 0;',
  );
  const env = { HOME: home, SHELL: shell, PATH: "/usr/bin:/bin", OPENCLAW_PROFILE: profile };
  const warnings: string[] = [];
  const install = (selected = profile, entry = entrypoint) =>
    installGatewayTerminalCli({
      env: { ...env, OPENCLAW_PROFILE: selected },
      command: { programArguments: [process.execPath, entry, "gateway", "--port", "19999"] },
      warn: (message) => warnings.push(message),
    });
  const run = (args = ["qr"], overrides = {}) => {
    const output = execFileSync(path.join(home, ".openclaw/bin/openclaw"), args, {
      env: { HOME: home, PATH: env.PATH, ...overrides },
      encoding: "utf8",
    });
    return JSON.parse(output) as { profile: string; args: string[] };
  };
  return { home, root, env, warnings, install, run, entrypoint };
}

describe.skipIf(process.platform === "win32")("Gateway terminal installation", () => {
  it.each(["default", "work"])(
    "makes a fresh %s installation discoverable through Bash startup files",
    async (profile) => {
      const f = await fixture(profile);
      await fs.writeFile(path.join(f.home, ".bashrc"), "# operator settings\n");
      await f.install();
      for (const rc of [".bashrc", ".profile"]) {
        // Explicitly source the appropriate startup file: Bash login on macOS also reads /etc/profile.
        const output = execFileSync(
          "/bin/bash",
          [
            "--noprofile",
            "--norc",
            "-c",
            '. "$HOME/' + rc + '"; openclaw qr "argument with spaces"',
          ],
          { env: { HOME: f.home, PATH: f.env.PATH }, encoding: "utf8" },
        );
        expect(JSON.parse(output)).toEqual({ profile, args: ["qr", "argument with spaces"] });
      }
      expect(f.warnings).toEqual([]);
      expect(await fs.readFile(path.join(f.home, ".bashrc"), "utf8")).toContain(
        "# operator settings\n",
      );
      const first = await fs.readFile(path.join(f.home, ".bashrc"), "utf8");
      await f.install();
      expect(await fs.readFile(path.join(f.home, ".bashrc"), "utf8")).toBe(first);
      expect(f.run()).toEqual({ profile, args: ["qr"] });
    },
  );

  it("preserves environment and explicit profile overrides through the installed launcher", async () => {
    const f = await fixture("work");
    await f.install();
    for (const [args, environment, expected] of [
      [["qr"], { OPENCLAW_PROFILE: "other" }, "other"],
      [["--profile", "default", "qr"], {}, "default"],
      [["--profile=work", "qr"], { OPENCLAW_PROFILE: "other" }, "work"],
    ] as const) {
      const observed = f.run([...args], environment);
      const parsed = parseCliProfileArgs([process.execPath, f.entrypoint, ...observed.args]);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        throw new Error(parsed.error);
      }
      const env = { HOME: f.home, OPENCLAW_PROFILE: observed.profile };
      applyCliProfileEnv({ env, profile: parsed.profile ?? observed.profile });
      expect(env.OPENCLAW_PROFILE).toBe(expected);
    }
    expect(() => f.run(["fail"])).toThrow(expect.objectContaining({ status: 23 }));
  });

  it("keeps the first named default across later installs and upgrades its owned launcher", async () => {
    const f = await fixture("first");
    await f.install();
    await f.install("second");
    await f.install("default");
    expect(f.run().profile).toBe("first");
    const next = path.join(f.root, "new-cli.mjs");
    await fs.writeFile(
      next,
      'console.log(JSON.stringify({profile: process.env.OPENCLAW_PROFILE, args: ["upgraded"]}));',
    );
    await f.install("first", next);
    expect(f.run()).toEqual({ profile: "first", args: ["upgraded"] });
  });

  it.each([".openclaw", ".openclaw-other"])(
    "does not steal a configured but offline %s selection",
    async (other) => {
      const f = await fixture("new");
      const directory = path.join(f.home, other);
      await fs.mkdir(directory);
      const config = '{"gateway":{"mode":"local","port":19998}}';
      await fs.writeFile(path.join(directory, "openclaw.json"), config);
      await f.install();
      expect(await fs.readFile(path.join(directory, "openclaw.json"), "utf8")).toBe(config);
      await expect(fs.lstat(path.join(f.home, ".openclaw/bin/openclaw"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(f.warnings.join("\n")).toContain("another profile is configured");
      const output = execFileSync(path.join(f.home, ".openclaw-new/bin/openclaw"), ["qr"], {
        env: { HOME: f.home },
        encoding: "utf8",
      });
      expect(JSON.parse(output)).toEqual({ profile: "new", args: ["qr"] });
    },
  );

  it.each(["file", "symlink"])(
    "preserves an operator-owned %s, including a dangling link",
    async (kind) => {
      const f = await fixture();
      const launcher = path.join(f.home, ".openclaw/bin/openclaw");
      await fs.mkdir(path.dirname(launcher), { recursive: true });
      if (kind === "symlink") {
        await fs.symlink("/missing/operator-cli", launcher);
      } else {
        await fs.writeFile(launcher, "operator command");
      }
      await f.install();
      expect(
        kind === "symlink" ? await fs.readlink(launcher) : await fs.readFile(launcher, "utf8"),
      ).toBe(kind === "symlink" ? "/missing/operator-cli" : "operator command");
      expect(f.warnings.join("\n")).toContain("Keeping existing terminal CLI");
      await expect(fs.lstat(path.join(f.home, ".bashrc"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("reports partial shell integration failure and preserves linked operator dotfiles", async () => {
    const f = await fixture();
    const outside = path.join(f.root, "operator-bashrc");
    await fs.writeFile(outside, "operator settings\n");
    await fs.symlink(outside, path.join(f.home, ".bashrc"));
    await f.install();
    expect(await fs.readFile(outside, "utf8")).toBe("operator settings\n");
    expect(f.warnings.join("\n")).toContain("Shell PATH setup skipped");
    expect(f.run().profile).toBe("default");
  });

  it("does not create a fish startup file through an operator directory symlink", async () => {
    const f = await fixture("fish", "/usr/bin/fish");
    const outside = path.join(f.root, "operator-config");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(f.home, ".config"));
    await f.install();
    expect(await fs.readdir(outside)).toEqual([]);
    expect(f.warnings.join("\n")).toContain("Shell PATH setup skipped");
  });

  it.skipIf(process.platform !== "darwin")(
    "discovers the CLI in clean interactive and login zsh shells",
    async () => {
      const f = await fixture("zshell", "/bin/zsh");
      await f.install();
      for (const mode of ["-ic", "-lic"]) {
        const output = execFileSync("/bin/zsh", [mode, "openclaw qr"], {
          env: { HOME: f.home, PATH: f.env.PATH },
          encoding: "utf8",
        });
        expect(JSON.parse(output)).toEqual({ profile: "zshell", args: ["qr"] });
      }
    },
  );

  it("retains only the installed runtime dependency, not service credentials, in the terminal child", async () => {
    const f = await fixture();
    await fs.writeFile(
      f.entrypoint,
      "console.log(JSON.stringify({sqlite:process.env.OPENCLAW_SQLITE_LIBRARY,token:process.env.OPENCLAW_GATEWAY_TOKEN}));",
    );
    await installGatewayTerminalCli({
      env: f.env,
      command: {
        programArguments: [process.execPath, f.entrypoint, "gateway"],
        environment: {
          OPENCLAW_SQLITE_LIBRARY: "/fixture path/libsqlite3.dylib",
          OPENCLAW_GATEWAY_TOKEN: "not-a-real-secret",
        },
      },
      warn: (message) => f.warnings.push(message),
    });
    expect(f.run()).toEqual({ sqlite: "/fixture path/libsqlite3.dylib" });
    expect(f.warnings).toEqual([]);
  });

  it("makes POSIX sh login setup usable without zsh", async () => {
    const f = await fixture("shell", "/bin/sh");
    await f.install();
    const output = execFileSync("/bin/sh", ["-c", '. "$HOME/.profile"; openclaw qr'], {
      env: { HOME: f.home, PATH: f.env.PATH },
      encoding: "utf8",
    });
    expect(JSON.parse(output)).toEqual({ profile: "shell", args: ["qr"] });
  });
});
