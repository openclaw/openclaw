import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { replaceFileAtomic } from "@openclaw/fs-safe/atomic";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyCliProfileEnv, parseCliProfileArgs } from "../cli/profile.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { installGatewayTerminalCli } from "./terminal-cli.js";

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

async function fixture(profile = "default", shell = "/bin/bash") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-terminal-"));
  roots.push(root);
  const home = path.join(root, "home with '$ characters");
  await fs.mkdir(home);
  const packageRoot = path.join(root, "package with ' quote");
  await fs.mkdir(packageRoot);
  await fs.writeFile(path.join(packageRoot, "package.json"), '{"name":"openclaw"}');
  const entrypoint = path.join(packageRoot, "openclaw.mjs");
  await fs.writeFile(
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
  it.each([
    ["default", ".local/bin"],
    ["default", "npm/bin"],
    ["new", ".local/bin"],
    ["new", "npm/bin"],
  ])("keeps the selected operator command for %s in %s", async (profile, directory) => {
    const f = await fixture(profile);
    const bin = path.join(f.home, directory);
    await fs.mkdir(bin, { recursive: true });
    const operator = path.join(bin, "openclaw");
    await fs.writeFile(operator, "#!/bin/sh\necho operator\n", { mode: 0o755 });
    f.env.PATH = bin + ":/usr/bin:/bin";
    await f.install();
    const output = execFileSync("/bin/bash", ["-ic", "openclaw qr"], {
      env: f.env,
      encoding: "utf8",
    });
    expect(output.trim()).toBe("operator");
    expect(f.warnings.join("\n")).toContain("Terminal default unchanged");
    await expect(fs.lstat(path.join(f.home, ".openclaw/bin/openclaw"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not adopt an opaque service wrapper that recursively invokes openclaw", async () => {
    const f = await fixture();
    const wrapper = path.join(f.root, "service-wrapper");
    await fs.writeFile(
      wrapper,
      '#!/bin/sh\n[ -z "$WRAPPED" ] || exit 44\nexport WRAPPED=1\nexec openclaw "$@"\n',
      { mode: 0o755 },
    );
    await installGatewayTerminalCli({
      env: f.env,
      command: { programArguments: [wrapper, "gateway"] },
      warn: (m) => f.warnings.push(m),
    });
    await expect(fs.lstat(path.join(f.home, ".openclaw/bin/openclaw"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(f.warnings.join("\n")).toContain("no reusable CLI entrypoint");
  });

  it("does not let a fresh default installation claim an offline named selection", async () => {
    const f = await fixture();
    const other = path.join(f.home, ".openclaw-first");
    await fs.mkdir(other);
    await fs.writeFile(path.join(other, "openclaw.json"), "{}");
    await f.install();
    await expect(fs.lstat(path.join(f.home, ".openclaw/bin/openclaw"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(f.warnings.join("\n")).toContain("another profile is configured");
  });

  it.skipIf(process.platform !== "darwin").each(["-ic", "-lic"])(
    "survives normal zsh PATH reset in %s startup without shadowing later operator setup",
    async (mode) => {
      const f = await fixture("work", "/bin/zsh");
      await fs.writeFile(path.join(f.home, ".zshrc"), "export PATH=/usr/bin:/bin\n");
      await fs.writeFile(path.join(f.home, ".zprofile"), "export PATH=/usr/bin:/bin\n");
      await f.install();
      const run = () =>
        execFileSync("/bin/zsh", [mode, "openclaw qr"], {
          env: { HOME: f.home, PATH: "/usr/bin:/bin" },
          encoding: "utf8",
        });
      expect(JSON.parse(run())).toEqual({ profile: "work", args: ["qr"] });
      const bin = path.join(f.home, "nvm/bin");
      await fs.mkdir(bin, { recursive: true });
      await fs.writeFile(path.join(bin, "openclaw"), "#!/bin/sh\necho version-manager\n", {
        mode: 0o755,
      });
      await fs.appendFile(path.join(f.home, ".zshrc"), '\nexport PATH="$HOME/nvm/bin:$PATH"\n');
      await f.install();
      expect(run().trim()).toBe("version-manager");
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "uses explicitly configured external ZDOTDIR for real zsh startup",
    async () => {
      const f = await fixture("zdot", "/bin/zsh");
      const directory = path.join(f.root, "zsh config");
      await fs.mkdir(directory);
      f.env.ZDOTDIR = directory;
      await f.install();
      const output = execFileSync("/bin/zsh", ["-ic", "openclaw qr"], {
        env: { HOME: f.home, PATH: "/usr/bin:/bin", ZDOTDIR: directory },
        encoding: "utf8",
      });
      expect(JSON.parse(output)).toEqual({ profile: "zdot", args: ["qr"] });
      await expect(fs.lstat(path.join(f.home, ".zshrc"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("does not follow a launcher replaced by an operator symlink after inspection", async () => {
    const f = await fixture();
    await f.install();
    const launcher = path.join(f.home, ".openclaw/bin/openclaw");
    const canary = path.join(f.root, "operator");
    await fs.writeFile(canary, "operator data", { mode: 0o600 });
    const { replaceFileAtomic: replace } = await vi.importActual<
      typeof import("@openclaw/fs-safe/atomic")
    >("@openclaw/fs-safe/atomic");
    let replaced = false;
    vi.mocked(replaceFileAtomic).mockImplementation((options) =>
      replace({
        ...options,
        beforeRename: async () => {
          if (options.filePath === launcher && !replaced) {
            replaced = true;
            await fs.unlink(launcher);
            await fs.symlink(canary, launcher);
          }
        },
      }),
    );
    const upgrade = path.join(path.dirname(f.entrypoint), "dist/index.js");
    await fs.mkdir(path.dirname(upgrade));
    await fs.copyFile(f.entrypoint, upgrade);
    await f.install("default", upgrade);
    expect(replaced).toBe(true);
    expect(await fs.readFile(canary, "utf8")).toBe("operator data");
    expect((await fs.stat(canary)).mode & 0o777).toBe(0o600);
    expect(f.warnings.length).toBeGreaterThan(0);
  });

  it("preserves a concurrent operator shell edit at atomic publication", async () => {
    const f = await fixture();
    const file = path.join(f.home, ".bashrc");
    await fs.writeFile(file, "# initial settings\n", { mode: 0o600 });
    const { replaceFileAtomic: replace } = await vi.importActual<
      typeof import("@openclaw/fs-safe/atomic")
    >("@openclaw/fs-safe/atomic");
    let edited = false;
    vi.mocked(replaceFileAtomic).mockImplementation((options) =>
      replace({
        ...options,
        beforeRename: async () => {
          if (options.filePath === file && !edited) {
            edited = true;
            await fs.appendFile(file, "# concurrent operator edit\n");
          }
        },
      }),
    );
    await f.install();
    expect(edited).toBe(true);
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
      await fs.chmod(f.home, 0o755);
      await fs.mkdir(directory);
      await fs.chmod(directory, 0o751);
      f.env.ZDOTDIR = directory;
      const file = path.join(directory, ".zshrc");
      await fs.writeFile(file, "# operator settings\n");
      await fs.writeFile(path.join(f.home, ".bashrc"), "# existing Bash settings\n");
      if (fail) {
        const { replaceFileAtomic: replace } = await vi.importActual<
          typeof import("@openclaw/fs-safe/atomic")
        >("@openclaw/fs-safe/atomic");
        vi.mocked(replaceFileAtomic).mockImplementation((options) =>
          replace({
            ...options,
            beforeRename: async () => {
              if (options.filePath === file) {
                throw new Error("fixture publication refusal");
              }
            },
          }),
        );
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
        expect(await fs.readFile(file, "utf8")).toContain("command -v openclaw");
      }
    },
  );

  it("preserves invalid UTF-8 shell bytes and reports unsupported input", async () => {
    const f = await fixture();
    const file = path.join(f.home, ".bashrc");
    const bytes = Buffer.from([0x23, 0x20, 0xff, 0x0a]);
    await fs.writeFile(file, bytes);
    await fs.chmod(file, 0o640);
    await f.install();
    expect(await fs.readFile(file)).toEqual(bytes);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o640);
    expect(f.warnings.join("\n")).toContain(file + " must be valid UTF-8");
    expect(f.run().profile).toBe("default");
  });

  it("does not split operator hardlinked startup files", async () => {
    const f = await fixture();
    const file = path.join(f.home, ".bashrc");
    const peer = path.join(f.root, "operator bashrc");
    await fs.writeFile(peer, "# shared operator settings\n");
    await fs.link(peer, file);
    const before = await fs.stat(peer);
    await f.install();
    const after = await fs.stat(file);
    expect(after.ino).toBe(before.ino);
    expect(after.nlink).toBe(2);
    expect(await fs.readFile(file, "utf8")).toBe("# shared operator settings\n");
    expect(await fs.readFile(peer, "utf8")).toBe("# shared operator settings\n");
    expect(f.warnings.join("\n")).toContain("Shell PATH setup skipped " + file);
  });

  it("makes the CLI available after a real interactive Bash PATH reset", async () => {
    const f = await fixture("bash");
    await fs.writeFile(path.join(f.home, ".bashrc"), "export PATH=/usr/bin:/bin\n");
    await f.install();
    const output = execFileSync("/bin/bash", ["-ic", "openclaw qr"], {
      env: { HOME: f.home, PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });
    expect(JSON.parse(output)).toEqual({ profile: "bash", args: ["qr"] });
  });

  it.skipIf(!fishExecutable).each([false, true])(
    "discovers the CLI after real fish startup with custom config=%s",
    async (external) => {
      if (!fishExecutable) {
        throw new Error("fish is unavailable");
      }
      const f = await fixture("fish", fishExecutable);
      const configRoot = external
        ? path.join(f.root, "external config")
        : path.join(f.home, ".config");
      if (external) {
        f.env.XDG_CONFIG_HOME = configRoot;
      }
      await fs.mkdir(path.join(configRoot, "fish"), { recursive: true });
      const file = path.join(configRoot, "fish/config.fish");
      await fs.writeFile(file, "set -gx PATH /usr/bin /bin\n");
      await f.install();
      const env = { HOME: f.home, PATH: "/usr/bin:/bin", XDG_CONFIG_HOME: configRoot };
      const output = execFileSync(fishExecutable, ["-ic", "openclaw qr"], {
        env,
        encoding: "utf8",
      });
      expect(JSON.parse(output)).toEqual({ profile: "fish", args: ["qr"] });
      const bin = path.join(f.home, "operator/bin");
      await fs.mkdir(bin, { recursive: true });
      await fs.writeFile(path.join(bin, "openclaw"), "#!/bin/sh\necho operator\n", { mode: 0o755 });
      await fs.appendFile(file, '\nset -gx PATH "$HOME/operator/bin" $PATH\n');
      await f.install();
      expect(
        execFileSync(fishExecutable, ["-ic", "openclaw qr"], { env, encoding: "utf8" }).trim(),
      ).toBe("operator");
    },
  );

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
    await fs.chmod(path.join(f.home, ".openclaw-first/bin/openclaw"), 0o644);
    await f.install();
    expect(f.run().profile).toBe("first");
    await f.install("second");
    await f.install("default");
    expect(f.run().profile).toBe("first");
    const next = path.join(path.dirname(f.entrypoint), "dist/entry.js");
    await fs.mkdir(path.dirname(next));
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

  it.each([undefined, "/fixture path/libsqlite3.dylib"])(
    "retains only the present installed runtime dependency (%s), not service credentials",
    async (sqlite) => {
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
            OPENCLAW_SQLITE_LIBRARY: sqlite,
            OPENCLAW_GATEWAY_TOKEN: "not-a-real-secret",
          },
        },
        warn: (message) => f.warnings.push(message),
      });
      expect(f.run()).toEqual(sqlite ? { sqlite } : {});
      expect(f.warnings).toEqual([]);
    },
  );

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
