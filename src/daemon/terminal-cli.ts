import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readRegularFile, readRegularFileSync, sameFileIdentity } from "@openclaw/fs-safe/advanced";
import { replaceFileAtomic } from "@openclaw/fs-safe/atomic";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isStandaloneRuntimeExecutable } from "../../cli-invocation.mjs";
import { normalizeProfileName, resolveProfileStateDir } from "../cli/profile-utils.js";
import { quoteCliArg, quotePowerShellArg } from "../cli/quote-cli-arg.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { isMissingPathError } from "../infra/errno.js";
import { isExecutableFileAsync, resolveExecutablePathAsync } from "../infra/executable-path.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { lstatIfExists } from "../infra/path-existence.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveEnvironmentValue } from "../infra/process-env.js";
import { appendShellProfilePath, resolveShellConfigRoot } from "../infra/shell-profile.js";
import { decodeUtf8Input } from "../infra/utf8-input.js";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import { isBunRuntime, isNodeRuntime } from "./runtime-binary.js";
import { resolveServiceEntrypointIndex, summarizeGatewayServiceLayout } from "./service-layout.js";
import type { GatewayServiceInstallArgs } from "./service-types.js";

const signature = "#!/bin/sh\n# OpenClaw managed terminal CLI\n";
type Snapshot = Awaited<ReturnType<typeof readRegularFile>> | undefined;

async function snapshot(file: string): Promise<Snapshot> {
  if (!(await lstatIfExists(file))) {
    return undefined;
  }
  const value = await readRegularFile({ filePath: file, maxBytes: 1024 * 1024 });
  if (value.stat.uid !== process.getuid?.()) {
    throw new Error("file is not user-owned");
  }
  return value;
}

/** Publish only over the exact inspected file, never through a replacement link or editor save. */
async function publish(
  file: string,
  root: string,
  previous: Snapshot,
  content: string,
  mode: number,
) {
  const physicalRoot = resolvePathViaExistingAncestorSync(root);
  const physical = resolvePathViaExistingAncestorSync(file);
  if (!isPathInside(physicalRoot, physical)) {
    throw new Error("terminal integration path is linked outside its configured directory");
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await replaceFileAtomic({
    filePath: file,
    content,
    mode,
    dirMode: "preserve",
    destinationHardlinks: "reject",
    tempPrefix: ".openclaw-terminal",
    assertBeforeMutation: () => {
      if (resolvePathViaExistingAncestorSync(file) !== physical) {
        throw new Error("terminal integration path changed during installation");
      }
      if (!previous) {
        try {
          lstatSync(file);
        } catch (error) {
          if (isMissingPathError(error)) {
            return;
          }
          throw error;
        }
      } else {
        const current = readRegularFileSync({ filePath: file, maxBytes: 1024 * 1024 });
        if (
          sameFileIdentity(current.exactIdentity, previous.exactIdentity) &&
          current.buffer.equals(previous.buffer) &&
          current.stat.mode === previous.stat.mode &&
          current.stat.uid === previous.stat.uid
        ) {
          return;
        }
      }
      throw new Error(
        "terminal integration file changed during installation; keeping operator changes",
      );
    },
  });
}

/** Install only the verified package CLI, preserving an established terminal selection. */
export async function installGatewayTerminalCli(params: {
  env: NodeJS.ProcessEnv;
  command: Pick<GatewayServiceInstallArgs, "programArguments" | "workingDirectory" | "environment">;
  warn: (message: string) => void;
}): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const { env, command, warn } = params;
  try {
    const index = resolveServiceEntrypointIndex(command.programArguments);
    const layout = await summarizeGatewayServiceLayout(command);
    const entrypoint = layout?.entrypoint;
    const packageRoot = layout?.packageRoot;
    const runtime = command.programArguments[0] ?? "";
    const packaged =
      index !== undefined &&
      index > 0 &&
      (isNodeRuntime(runtime) || isBunRuntime(runtime)) &&
      packageRoot &&
      entrypoint &&
      ["openclaw.mjs", "dist/index.js", "dist/index.mjs", "dist/entry.js"].some(
        (name) => path.join(packageRoot, name) === entrypoint,
      );
    if (
      index === undefined ||
      !entrypoint ||
      (!packaged && !(index === 0 && isStandaloneRuntimeExecutable(runtime)))
    ) {
      warn(
        "Terminal CLI setup skipped: the installed Gateway command has no reusable CLI entrypoint.",
      );
      return;
    }
    const home = resolveRequiredHomeDir(env);
    const profile = normalizeProfileName(env.OPENCLAW_PROFILE) ?? "default";
    const state = resolveProfileStateDir(profile, env, () => home);
    const prefix = [...command.programArguments.slice(0, index), entrypoint];
    const contextual = prefix.map(quoteCliArg).join(" ") + " --profile " + profile;
    if (
      path.resolve(resolveStateDir(env)) !== state ||
      path.resolve(resolveConfigPath(env)) !== path.join(state, "openclaw.json")
    ) {
      warn(
        "Terminal default unchanged for custom state/config paths. Keep those environment overrides when running " +
          contextual,
      );
      return;
    }
    const launcher = path.join(state, "bin/openclaw");
    const terminal = path.join(home, ".openclaw/bin/openclaw");
    const existing = await lstatIfExists(launcher);
    const previous = existing?.isFile() ? await snapshot(launcher) : undefined;
    if (existing && !previous?.buffer.toString("utf8").startsWith(signature)) {
      warn("Keeping existing terminal CLI at " + launcher + "; this Gateway: " + contextual);
      return;
    }
    const selected = await resolveExecutablePathAsync("openclaw", {
      env: { ...env, PATH: env.PATH ?? "" },
      useCache: false,
    });
    const selectedOther =
      selected &&
      (await fs.realpath(selected)) !== (await fs.realpath(launcher).catch(() => launcher));
    const terminalExists = await lstatIfExists(terminal);
    let otherConfigured = false;
    if (!terminalExists) {
      for (const name of await fs.readdir(home)) {
        if (
          (name === ".openclaw" || name.startsWith(".openclaw-")) &&
          path.join(home, name) !== state &&
          (await lstatIfExists(path.join(home, name, "openclaw.json")))
        ) {
          otherConfigured = true;
          break;
        }
      }
    }
    // The canonical pathname alone is not proof of selection ownership.
    if (!previous && launcher === terminal && (selectedOther || otherConfigured)) {
      warn(
        "Terminal default unchanged" +
          (otherConfigured ? ": another profile is configured" : ": keeping " + selected) +
          "; this Gateway: " +
          contextual,
      );
      return;
    }
    const sqlite = command.environment?.OPENCLAW_SQLITE_LIBRARY?.trim();
    const sqliteLine = sqlite ? `export OPENCLAW_SQLITE_LIBRARY=${quoteCliArg(sqlite)}\n` : "";
    const shim = `${signature}export OPENCLAW_PROFILE="\${OPENCLAW_PROFILE:-${profile}}"\n${sqliteLine}exec ${prefix.map(quoteCliArg).join(" ")} "$@"\n`;
    if (previous?.buffer.toString("utf8") !== shim || (previous.stat.mode & 0o777) !== 0o755) {
      await publish(launcher, home, previous, shim, 0o755);
    }
    if (selectedOther || otherConfigured) {
      warn(
        "Terminal default unchanged" +
          (otherConfigured ? ": another profile is configured" : ": keeping " + selected) +
          "; this Gateway: " +
          launcher,
      );
      return;
    }
    if (launcher !== terminal) {
      if (terminalExists) {
        if (!terminalExists.isSymbolicLink() || (await fs.readlink(terminal)) !== launcher) {
          warn("Terminal default unchanged; this Gateway: " + launcher);
          return;
        }
      } else {
        const bin = path.dirname(terminal);
        if (
          !isPathInside(
            resolvePathViaExistingAncestorSync(home),
            resolvePathViaExistingAncestorSync(bin),
          )
        ) {
          throw new Error("terminal bin directory points outside HOME");
        }
        await fs.mkdir(bin, { recursive: true });
        await fs.symlink(launcher, terminal);
      }
    }
    await installShellPath({ home, bin: path.dirname(terminal), env, warn });
  } catch (error) {
    warn("Gateway installed, but terminal CLI setup failed: " + String(error));
  }
}

/** PATH-only bridge for the desktop's qualified launcher. Never creates config or a CLI. */
export async function installDesktopTerminalPath(
  launcher: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const home = resolveRequiredHomeDir(env);
  const windows = process.platform === "win32";
  const expected = path.join(home, ".openclaw/bin", windows ? "openclaw.cmd" : "openclaw");
  const metadata = await lstatIfExists(launcher);
  if (
    launcher !== expected ||
    !metadata?.isFile() ||
    !(await isExecutableFileAsync(launcher, { env }))
  ) {
    throw new Error("Terminal PATH setup requires the executable app-managed CLI launcher.");
  }
  const bytes = await readRegularFile({ filePath: launcher, maxBytes: 65536 });
  const marker = decodeUtf8Input(bytes.buffer, launcher).split(/\r?\n/)[1];
  const prefix = windows ? "@rem # OpenClaw-Tauri runtime v1 " : "# OpenClaw-Tauri runtime v1 ";
  const selection: unknown = marker?.startsWith(prefix)
    ? JSON.parse(marker.slice(prefix.length))
    : undefined;
  if (
    !isRecord(selection) ||
    selection.purpose !== "gateway" ||
    !isRecord(selection.runtime) ||
    typeof selection.runtime.bun !== "string" ||
    typeof selection.entry !== "string" ||
    (await fs.realpath(selection.runtime.bun)) !== (await fs.realpath(process.execPath)) ||
    (await fs.realpath(selection.entry)) !==
      (await fs.realpath(
        selection.runtime.flavor === "aot" ? process.execPath : (process.argv[1] ?? ""),
      ))
  ) {
    throw new Error("Terminal PATH setup requires the CLI currently qualified by the desktop app.");
  }
  const selected = await resolveExecutablePathAsync("openclaw", {
    env: { ...env, PATH: resolveEnvironmentValue(env, "PATH") ?? "" },
    useCache: false,
  });
  if (selected && (await fs.realpath(selected)) !== (await fs.realpath(launcher))) {
    return "Terminal default unchanged; keeping the existing selected CLI: " + selected;
  }
  if (!(await lstatIfExists(path.join(home, ".openclaw/openclaw.json")))) {
    for (const directory of await fs.readdir(home)) {
      if (
        directory.startsWith(".openclaw-") &&
        (await lstatIfExists(path.join(home, directory, "openclaw.json")))
      ) {
        return "Terminal default unchanged; another profile is configured.";
      }
    }
  }
  const bin = path.dirname(launcher);
  if (bin.includes(path.delimiter)) {
    throw new Error(
      "Terminal CLI directory contains the PATH separator; keep the existing PATH unchanged.",
    );
  }
  if (windows) {
    const extensions = (resolveEnvironmentValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
      .toUpperCase()
      .split(";");
    if (!extensions.includes(".CMD")) {
      throw new Error(
        "Terminal PATH setup needs .CMD in PATHEXT to resolve the installed launcher.",
      );
    }
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')",
      "try {",
      "  $raw = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
      "  $kind = if ($null -eq $raw) { [Microsoft.Win32.RegistryValueKind]::ExpandString } else { $key.GetValueKind('Path') }",
      "  if ($kind -notin @([Microsoft.Win32.RegistryValueKind]::String, [Microsoft.Win32.RegistryValueKind]::ExpandString)) { throw 'User PATH is not a registry string.' }",
      `  $bin = ${quotePowerShellArg(bin)}`,
      "  $entries = @(([string]$raw -split ';') | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).Trim('\"').TrimEnd('\\', '/') })",
      "  if ($entries -notcontains $bin.TrimEnd('\\', '/')) {",
      "    $next = if ([string]::IsNullOrEmpty($raw)) { $bin } else { $raw + ';' + $bin }",
      "    if ($key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -cne $raw -or ($null -ne $raw -and $key.GetValueKind('Path') -ne $kind)) { throw 'User PATH changed; retry terminal setup.' }",
      "    $key.SetValue('Path', $next, $kind)",
      "  }",
      "} finally { $key.Dispose() }",
      "Add-Type -Namespace OpenClaw -Name TerminalEnvironment -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"user32.dll\", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.IntPtr wParam, string lParam, uint flags, uint timeout, out System.IntPtr result);'",
      "$result = [IntPtr]::Zero",
      "if ([OpenClaw.TerminalEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [IntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) -eq [IntPtr]::Zero) { throw 'User PATH saved, but environment notification failed. Sign out and back in before opening a terminal.' }",
    ].join("\n");
    execFileSync(
      getWindowsPowerShellExePath(env),
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        env,
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } else {
    const warnings: string[] = [];
    await installShellPath({ home, bin, env, warn: (warning) => warnings.push(warning) });
    if (warnings.length > 0) {
      throw new Error(
        "CLI installed, but terminal PATH setup is incomplete: " + warnings.join("\n"),
      );
    }
  }
  return "CLI available in new terminals. Existing CLI configuration and connection are unchanged.";
}

async function installShellPath(params: {
  home: string;
  bin: string;
  env: NodeJS.ProcessEnv;
  warn: (message: string) => void;
}) {
  const { home, bin, env, warn } = params;
  const bashLogin = (await lstatIfExists(path.join(home, ".bash_profile")))
    ? ".bash_profile"
    : (await lstatIfExists(path.join(home, ".bash_login")))
      ? ".bash_login"
      : ".profile";
  const zsh = resolveShellConfigRoot("zsh", env, home);
  const fish = resolveShellConfigRoot("fish", env, home);
  const candidates = [
    { file: path.join(home, ".bashrc"), root: home, shell: "bash" },
    { file: path.join(home, bashLogin), root: home, shell: "bash" },
    { file: appendShellProfilePath(zsh, path.posix, ".zshrc"), root: zsh, shell: "zsh" },
    { file: appendShellProfilePath(zsh, path.posix, ".zprofile"), root: zsh, shell: "zsh" },
    {
      file: appendShellProfilePath(fish, path.posix, "fish", "config.fish"),
      root: env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? fish : home,
      shell: "fish",
    },
  ];
  const shell = path.basename(env.SHELL ?? "/bin/sh");
  if (!["bash", "zsh", "fish", "sh"].includes(shell)) {
    warn("Terminal CLI installed; add " + bin + " to PATH for " + shell + ".");
    return;
  }
  if (shell === "sh" && bashLogin !== ".profile") {
    candidates.push({ file: path.join(home, ".profile"), root: home, shell: "sh" });
  }
  const fishPath = "'" + bin.replaceAll("\\", "\\\\").replaceAll("'", "\\'") + "'";
  for (const target of candidates) {
    if (
      target.shell !== shell &&
      !(shell === "sh" && path.basename(target.file) === ".profile") &&
      !(await lstatIfExists(target.file))
    ) {
      continue;
    }
    try {
      const previous = await snapshot(target.file);
      const current = previous ? decodeUtf8Input(previous.buffer, target.file) : "";
      // Append after normal initialization, and never precede a deliberate command selection.
      const line =
        target.shell === "fish"
          ? "if not type -q openclaw; fish_add_path --path --append -- " + fishPath + "; end"
          : 'if ! command -v openclaw >/dev/null 2>&1; then export PATH="$PATH":' +
            quoteCliArg(bin) +
            "; fi";
      if (current.split("\n").includes(line)) {
        continue;
      }
      await publish(
        target.file,
        target.root,
        previous,
        current + (current.endsWith("\n") || !current ? "" : "\n") + line + "\n",
        previous ? previous.stat.mode & 0o777 : 0o644,
      );
    } catch (error) {
      warn(
        "Shell PATH setup skipped " +
          target.file +
          ": " +
          String(error) +
          "; add " +
          bin +
          " to PATH manually.",
      );
    }
  }
}
