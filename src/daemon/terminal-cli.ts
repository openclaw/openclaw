import { lstatSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readRegularFile, readRegularFileSync, sameFileIdentity } from "@openclaw/fs-safe/advanced";
import { replaceFileAtomic } from "@openclaw/fs-safe/atomic";
import { isStandaloneRuntimeExecutable } from "../../cli-invocation.mjs";
import { normalizeProfileName, resolveProfileStateDir } from "../cli/profile-utils.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { isMissingPathError } from "../infra/errno.js";
import { resolveExecutablePathAsync } from "../infra/executable-path.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { lstatIfExists } from "../infra/path-existence.js";
import { isPathInside } from "../infra/path-guards.js";
import { appendShellProfilePath, resolveShellConfigRoot } from "../infra/shell-profile.js";
import { decodeUtf8Input } from "../infra/utf8-input.js";
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
