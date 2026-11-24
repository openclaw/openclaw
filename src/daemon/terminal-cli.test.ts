import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { replaceFileAtomic } from "@openclaw/fs-safe/atomic";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyCliProfileEnv, parseCliProfileArgs } from "../cli/profile.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { installDesktopTerminalPath, installGatewayTerminalCli } from "./terminal-cli.js";

vi.mock("@openclaw/fs-safe/atomic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/atomic")>();
  return { ...actual, replaceFileAtomic: vi.fn(actual.replaceFileAtomic) };
});

const roots: string[] = [];
const fishExecutable = resolveExecutablePath("fish");
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(replaceFileAtomic).mockReset();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function writeFixtureFile(file: string, content: string | Buffer, mode?: number) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, { mode });
  if (mode !== undefined) {
    await fs.chmod(file, mode);
  }
}

async function expectMissing(file: string) {
  await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
}

async function interceptPublication(file: string, mutation: () => Promise<unknown>) {
  const { replaceFileAtomic: replace } = await vi.importActual<
    typeof import("@openclaw/fs-safe/atomic")
  >("@openclaw/fs-safe/atomic");
  const mutate = vi.fn(mutation);
  vi.mocked(replaceFileAtomic).mockImplementation((options) =>
    replace({
      ...options,
      beforeRename: async () => {
        if (options.filePath === file && mutate.mock.calls.length === 0) {
          await mutate();
        }
      },
    }),
  );
  return mutate;
}

async function fixture(profile = "default", shell = "/bin/bash") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-terminal-"));
  roots.push(root);
  const home = path.join(root, "home with '$ characters");
  // Keep distro first-login notices out of stdout without bypassing shell startup.
  await writeFixtureFile(path.join(home, ".hushlogin"), "");
  const packageRoot = path.join(root, "package with ' quote");
  await writeFixtureFile(path.join(packageRoot, "package.json"), '{"name":"openclaw"}');
  const entrypoint = path.join(packageRoot, "openclaw.mjs");
  await writeFixtureFile(
    entrypoint,
    'console.log(JSON.stringify({profile: process.env.OPENCLAW_PROFILE, args: process.argv.slice(2)})); process.exitCode = process.argv.includes("fail") ? 23 : 0;',
  );
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    SHELL: shell,
    PATH: "/usr/bin:/bin",
    OPENCLAW_PROFILE: profile,
  };
  const warnings: string[] = [];
  const environment: NodeJS.ProcessEnv = {};
  const launcher = path.join(home, ".openclaw/bin/openclaw");
  const install = (selected = profile, entry = entrypoint) =>
    installGatewayTerminalCli({
      env: { ...env, OPENCLAW_PROFILE: selected },
      command: {
        programArguments: [process.execPath, entry, "gateway", "--port", "19999"],
        environment,
      },
      warn: (message) => warnings.push(message),
    });
  const execute = (command: string, args: string[], overrides: NodeJS.ProcessEnv = {}) =>
    execFileSync(command, args, {
      env: { HOME: home, PATH: env.PATH, ...overrides },
      encoding: "utf8",
    });
  const run = (args = ["qr"], overrides = {}) =>
    JSON.parse(execute(launcher, args, overrides)) as { profile: string; args: string[] };
  const operator = async (directory: string, output: string) => {
    const bin = path.join(home, directory);
    await writeFixtureFile(path.join(bin, "openclaw"), "#!/bin/sh\necho " + output + "\n", 0o755);
    return bin;
  };
  return {
    home,
    root,
    env,
    environment,
    launcher,
    warnings,
    install,
    run,
    execute,
    operator,
    entrypoint,
  };
}

describe.skipIf(process.platform === "win32")("Gateway terminal installation", () => {
  it.each([
    "selected",
    "offline",
    "browser",
    "wrong runtime",
    "linked",
    "partial",
    "not-directory",
  ])("desktop PATH setup preserves %s state without replacing its launcher", async (kind) => {
    const f = await fixture();
    const profileHome = path.join(f.root, "profile-home-file");
    const marker = {
      purpose: kind === "browser" ? "browser" : "gateway",
      runtime: { bun: kind === "wrong runtime" ? "/missing/runtime" : process.execPath },
      entry: process.argv[1],
    };
    const content =
      "#!/bin/sh\n# OpenClaw-Tauri runtime v1 " + JSON.stringify(marker) + "\nexit 0\n";
    await writeFixtureFile(f.launcher, content, 0o755);
    if (kind === "selected") {
      f.env.PATH = (await f.operator("operator/bin", "operator")) + ":/usr/bin:/bin";
    } else if (kind === "offline") {
      await writeFixtureFile(path.join(f.home, ".openclaw-work/openclaw.json"), "operator config");
    } else if (kind === "not-directory") {
      f.env.OPENCLAW_HOME = profileHome;
      await fs.writeFile(f.env.OPENCLAW_HOME, "operator data");
    } else if (kind === "linked") {
      const peer = path.join(f.root, "operator-cli");
      await fs.rename(f.launcher, peer);
      await fs.symlink(peer, f.launcher);
    } else if (kind === "partial") {
      await writeFixtureFile(path.join(f.home, ".bashrc"), Buffer.from([0xff]));
    }
    const apply = () => installDesktopTerminalPath(f.launcher, f.env);
    if (kind === "selected" || kind === "offline") {
      expect(await apply()).toContain("Terminal default unchanged");
    } else if (kind === "not-directory") {
      await expect(apply()).rejects.toMatchObject({ code: "ENOTDIR" });
      expect(await fs.readFile(profileHome, "utf8")).toBe("operator data");
    } else {
      await expect(apply()).rejects.toThrow();
    }
    expect(await fs.readFile(f.launcher, "utf8")).toBe(content);
    await expectMissing(path.join(f.home, ".openclaw/openclaw.json"));
    if (kind !== "partial") {
      await expectMissing(path.join(f.home, ".bashrc"));
    } else {
      expect(await fs.readFile(path.join(f.home, ".bashrc"))).toEqual(Buffer.from([0xff]));
    }
  });
  it.each([
    ["default", ".local/bin"],
    ["default", "npm/bin"],
    ["new", ".local/bin"],
    ["new", "npm/bin"],
  ])("keeps the selected operator command for %s in %s", async (profile, directory) => {
    const f = await fixture(profile);
    f.env.PATH = (await f.operator(directory, "operator")) + ":/usr/bin:/bin";
    await f.install();
    expect(f.execute("/bin/bash", ["-ic", "openclaw qr"]).trim()).toBe("operator");
    expect(f.warnings.join("\n")).toContain("Terminal default unchanged");
    await expectMissing(f.launcher);
  });

  it.each([
    ["npx", ".npm/_npx/hash/node_modules"],
    ["pnpm dlx", ".cache/pnpm/dlx/key/stamp/node_modules"],
    ["bunx", ".bunx-1000/node_modules"],
  ])(
    "does not keep a one-off runner's copy in %s as the terminal default",
    async (_runner, directory) => {
      const f = await fixture();
      const modules = path.join(f.root, directory);
      await writeFixtureFile(
        path.join(modules, "openclaw/openclaw.mjs"),
        "#!/bin/sh\nexit 0\n",
        0o755,
      );
      const runnerBin = path.join(modules, ".bin");
      await fs.mkdir(runnerBin, { recursive: true });
      await fs.symlink("../openclaw/openclaw.mjs", path.join(runnerBin, "openclaw"));
      f.env.PATH = [runnerBin, "/usr/bin", "/bin"].join(path.delimiter);
      await f.install();
      expect(f.warnings).toEqual([]);
      const output = f.execute("/bin/bash", ["-ic", "openclaw qr"], {
        PATH: "/usr/bin:/bin",
      });
      expect(JSON.parse(output)).toEqual({ profile: "default", args: ["qr"] });
    },
  );

  it("keeps an operator command that follows a one-off runner on PATH", async () => {
    const f = await fixture();
    const runnerBin = path.join(f.root, ".npm/_npx/hash/node_modules/.bin");
    await writeFixtureFile(path.join(runnerBin, "openclaw"), "#!/bin/sh\necho runner\n", 0o755);
    const operatorBin = await f.operator(".local/bin", "operator");
    f.env.PATH = [runnerBin, operatorBin, "/usr/bin", "/bin"].join(path.delimiter);
    await f.install();
    expect(f.warnings.join("\n")).toContain("keeping " + path.join(operatorBin, "openclaw"));
    await expectMissing(f.launcher);
  });

  it("does not adopt an opaque service wrapper that recursively invokes openclaw", async () => {
    const f = await fixture();
    const wrapper = path.join(f.root, "service-wrapper");
    await writeFixtureFile(
      wrapper,
      '#!/bin/sh\n[ -z "$WRAPPED" ] || exit 44\nexport WRAPPED=1\nexec openclaw "$@"\n',
      0o755,
    );
    await installGatewayTerminalCli({
      env: f.env,
      command: { programArguments: [wrapper, "gateway"] },
      warn: (m) => f.warnings.push(m),
    });
    await expectMissing(f.launcher);
    expect(f.warnings.join("\n")).toContain("no reusable CLI entrypoint");
  });

  describe.each([
    ["bash", "-ic", "default", false, true],
    ["bash", "-ic", "work", false, true],
    ["zsh", "-ic", "zshell", false, true],
    ["zsh", "-lic", "zshell", false, true],
    ["zsh", "-ic", "zshell", false, false],
    ["zsh", "-lic", "zshell", false, false],
    ["zsh", "-ic", "zshell", true, false],
    ["fish", "-ic", "fish", false, true],
    ["fish", "-ic", "fish", true, true],
    ["sh", "-c", "shell", false, false],
  ] as const)("%s %s profile=%s external=%s reset=%s", (shell, mode, profile, external, reset) => {
    const executable = shell === "fish" ? fishExecutable : "/bin/" + shell;
    it.skipIf(!executable || (shell === "zsh" && process.platform !== "darwin"))(
      "discovers the CLI without stealing later operator selection",
      async () => {
        if (!executable) {
          throw new Error("shell is unavailable");
        }
        const f = await fixture(profile, executable);
        const root = external ? path.join(f.root, "external config") : f.home;
        const directory = shell === "fish" && !external ? path.join(root, ".config") : root;
        const rc =
          shell === "fish" ? "fish/config.fish" : shell === "sh" ? ".profile" : "." + shell + "rc";
        const file = path.join(directory, rc);
        if (external) {
          f.env[shell === "fish" ? "XDG_CONFIG_HOME" : "ZDOTDIR"] = directory;
        }
        if (reset) {
          const resetPath =
            shell === "fish" ? "set -gx PATH /usr/bin /bin" : "export PATH=/usr/bin:/bin";
          for (const startup of shell === "zsh" ? [rc, ".zprofile"] : [rc]) {
            await writeFixtureFile(
              path.join(directory, startup),
              "# operator settings\n" + resetPath + "\n",
            );
          }
        }
        await f.install();
        const command = shell === "sh" ? '. "$HOME/.profile"; openclaw qr' : "openclaw qr";
        const run = () =>
          f.execute(executable, [mode, command], {
            ZDOTDIR: f.env.ZDOTDIR,
            XDG_CONFIG_HOME: f.env.XDG_CONFIG_HOME,
          });
        expect(JSON.parse(run())).toEqual({ profile, args: ["qr"] });
        expect(f.warnings).toEqual([]);
        if (shell === "zsh" && external) {
          await expectMissing(path.join(f.home, ".zshrc"));
        }
        if (shell === "bash") {
          for (const startup of [".bashrc", ".profile"]) {
            // Explicit sourcing avoids macOS /etc/profile altering the login environment.
            const source = '. "$HOME/' + startup + '"; openclaw qr "argument with spaces"';
            const output = f.execute(executable, ["--noprofile", "--norc", "-c", source]);
            expect(JSON.parse(output)).toEqual({ profile, args: ["qr", "argument with spaces"] });
          }
          expect(await fs.readFile(file, "utf8")).toContain("# operator settings\n");
        }
        const first = await fs.readFile(file, "utf8");
        await f.install();
        expect(await fs.readFile(file, "utf8")).toBe(first);
        expect(f.run()).toEqual({ profile, args: ["qr"] });
        if (shell !== "sh") {
          await f.operator("operator/bin", "operator");
          const select =
            shell === "fish"
              ? 'set -gx PATH "$HOME/operator/bin" $PATH'
              : 'export PATH="$HOME/operator/bin:$PATH"';
          await fs.appendFile(file, "\n" + select + "\n");
          await f.install();
          expect(run().trim()).toBe("operator");
        }
      },
    );
  });

  it("does not follow a launcher replaced by an operator symlink after inspection", async () => {
    const f = await fixture();
    await f.install();
    const canary = path.join(f.root, "operator");
    await writeFixtureFile(canary, "operator data", 0o600);
    const mutate = await interceptPublication(f.launcher, async () => {
      await fs.unlink(f.launcher);
      await fs.symlink(canary, f.launcher);
    });
    const upgrade = path.join(path.dirname(f.entrypoint), "dist/index.js");
    await writeFixtureFile(upgrade, await fs.readFile(f.entrypoint));
    await f.install("default", upgrade);
    expect(mutate).toHaveBeenCalledOnce();
    expect(await fs.readFile(canary, "utf8")).toBe("operator data");
    expect((await fs.stat(canary)).mode & 0o777).toBe(0o600);
    expect(f.warnings.length).toBeGreaterThan(0);
  });

  it("preserves a concurrent operator shell edit at atomic publication", async () => {
    const f = await fixture();
    const file = path.join(f.home, ".bashrc");
    await writeFixtureFile(file, "# initial settings\n", 0o600);
    const mutate = await interceptPublication(file, () =>
      fs.appendFile(file, "# concurrent operator edit\n"),
    );
    await f.install();
    expect(mutate).toHaveBeenCalledOnce();
    expect(await fs.readFile(file, "utf8")).toBe(
      "# initial settings\n# concurrent operator edit\n",
    );
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(f.warnings.join("\n")).toContain("Shell PATH setup skipped");
  });

  it.each([false, true])(
    "preserves HOME and external startup-directory modes when publication fails=%s",
    async (fail) => {
      const f = await fixture("permissions", "/bin/zsh");
      const directory = path.join(f.root, "external zsh");
      const file = path.join(directory, ".zshrc");
      await writeFixtureFile(file, "# operator settings\n");
      await fs.chmod(f.home, 0o755);
      await fs.chmod(directory, 0o751);
      f.env.ZDOTDIR = directory;
      await writeFixtureFile(path.join(f.home, ".bashrc"), "# existing Bash settings\n");
      if (fail) {
        await interceptPublication(file, async () => {
          throw new Error("fixture publication refusal");
        });
      }
      await f.install();
      expect((await fs.stat(f.home)).mode & 0o777).toBe(0o755);
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o751);
      expect(await fs.readFile(file, "utf8")).toContain("# operator settings\n");
      if (fail) {
        expect(await fs.readFile(file, "utf8")).toBe("# operator settings\n");
        expect(f.warnings.join("\n")).toContain("fixture publication refusal");
      } else {
        expect(f.warnings).toEqual([]);
        const command = '. "$ZDOTDIR/.zshrc"; openclaw qr';
        const output = f.execute("/bin/sh", ["-c", command], { ZDOTDIR: directory });
        expect(JSON.parse(output)).toEqual({ profile: "permissions", args: ["qr"] });
      }
    },
  );

  it.each(["symlink", "hardlink", "invalid UTF-8"])(
    "preserves %s startup data and reports partial integration",
    async (kind) => {
      const f = await fixture();
      const file = path.join(f.home, ".bashrc");
      const peer = path.join(f.root, "operator-bashrc");
      const bytes =
        kind === "invalid UTF-8"
          ? Buffer.from([0x23, 0x20, 0xff, 0x0a])
          : Buffer.from("# shared operator settings\n");
      await writeFixtureFile(peer, bytes, 0o640);
      if (kind === "symlink") {
        await fs.symlink(peer, file);
      } else if (kind === "hardlink") {
        await fs.link(peer, file);
      } else {
        await fs.copyFile(peer, file);
      }
      const before = await fs.lstat(file);
      await f.install();
      expect(await fs.lstat(file)).toMatchObject({
        ino: before.ino,
        mode: before.mode,
        nlink: kind === "hardlink" ? 2 : before.nlink,
      });
      expect(await fs.readFile(file)).toEqual(bytes);
      expect(await fs.readFile(peer)).toEqual(bytes);
      expect((await fs.stat(file)).mode & 0o777).toBe(0o640);
      expect(f.warnings.join("\n")).toContain("Shell PATH setup skipped " + file);
      if (kind === "invalid UTF-8") {
        expect(f.warnings.join("\n")).toContain(file + " must be valid UTF-8");
      }
      expect(f.run().profile).toBe("default");
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
    await fs.chmod(path.join(f.home, ".openclaw-first/bin/openclaw"), 0o644);
    await f.install();
    expect(f.run().profile).toBe("first");
    await f.install("second");
    await f.install("default");
    expect(f.run().profile).toBe("first");
    const next = path.join(path.dirname(f.entrypoint), "dist/entry.js");
    await writeFixtureFile(
      next,
      'console.log(JSON.stringify({profile: process.env.OPENCLAW_PROFILE, args: ["upgraded"]}));',
    );
    await f.install("first", next);
    expect(f.run()).toEqual({ profile: "first", args: ["upgraded"] });
  });

  it.each([
    ["default", ".openclaw-first"],
    ["new", ".openclaw"],
    ["new", ".openclaw-other"],
  ])("keeps offline configured selection when installing %s beside %s", async (profile, other) => {
    const f = await fixture(profile);
    const configFile = path.join(f.home, other, "openclaw.json");
    const config = '{"gateway":{"mode":"local","port":19998}}';
    await writeFixtureFile(configFile, config);
    await f.install();
    expect(await fs.readFile(configFile, "utf8")).toBe(config);
    await expectMissing(f.launcher);
    expect(f.warnings.join("\n")).toContain("another profile is configured");
    if (profile !== "default") {
      const output = f.execute(path.join(f.home, ".openclaw-new/bin/openclaw"), ["qr"]);
      expect(JSON.parse(output)).toEqual({ profile: "new", args: ["qr"] });
    }
  });

  it.each(["file", "symlink"])(
    "preserves an operator-owned %s, including a dangling link",
    async (kind) => {
      const f = await fixture();
      await fs.mkdir(path.dirname(f.launcher), { recursive: true });
      if (kind === "symlink") {
        await fs.symlink("/missing/operator-cli", f.launcher);
      } else {
        await fs.writeFile(f.launcher, "operator command");
      }
      await f.install();
      expect(
        kind === "symlink" ? await fs.readlink(f.launcher) : await fs.readFile(f.launcher, "utf8"),
      ).toBe(kind === "symlink" ? "/missing/operator-cli" : "operator command");
      expect(f.warnings.join("\n")).toContain("Keeping existing terminal CLI");
      await expectMissing(path.join(f.home, ".bashrc"));
    },
  );

  it("does not create a fish startup file through an operator directory symlink", async () => {
    const f = await fixture("fish", "/usr/bin/fish");
    const outside = path.join(f.root, "operator-config");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(f.home, ".config"));
    await f.install();
    expect(await fs.readdir(outside)).toEqual([]);
    expect(f.warnings.join("\n")).toContain("Shell PATH setup skipped");
  });

  it.each([undefined, "/fixture path/libsqlite3.dylib"])(
    "retains only the present installed runtime dependency (%s), not service credentials",
    async (sqlite) => {
      const f = await fixture();
      await fs.writeFile(
        f.entrypoint,
        "console.log(JSON.stringify({sqlite:process.env.OPENCLAW_SQLITE_LIBRARY,token:process.env.OPENCLAW_GATEWAY_TOKEN}));",
      );
      f.environment.OPENCLAW_SQLITE_LIBRARY = sqlite;
      f.environment.OPENCLAW_GATEWAY_TOKEN = "not-a-real-secret";
      await f.install();
      expect(f.run()).toEqual(sqlite ? { sqlite } : {});
      expect(f.warnings).toEqual([]);
    },
  );
});
