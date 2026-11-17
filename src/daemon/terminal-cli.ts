import fs from "node:fs/promises";
import path from "node:path";
import { normalizeProfileName, resolveProfileStateDir } from "../cli/profile-utils.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { isMissingPathError } from "../infra/errno.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { lstatIfExists } from "../infra/path-existence.js";
import { resolveServiceEntrypoint, resolveServiceEntrypointIndex } from "./service-layout.js";
import type { GatewayServiceCommandConfig } from "./service-types.js";

const signature = "#!/bin/sh\n# OpenClaw managed terminal CLI\n";

/** Install the verified service's CLI, without replacing another installation's terminal default. */
export async function installGatewayTerminalCli(params: {
  env: NodeJS.ProcessEnv;
  command: Pick<
    GatewayServiceCommandConfig,
    "programArguments" | "workingDirectory" | "environment"
  >;
  warn: (message: string) => void;
}): Promise<void> {
  if (process.platform === "win32") {
    return; // Windows installation owns command discovery through its package manager.
  }
  const { env, command, warn } = params;
  const entrypoint = resolveServiceEntrypoint(command);
  const index = resolveServiceEntrypointIndex(command.programArguments);
  if (!entrypoint || index === undefined) {
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
  try {
    // Profile flags populate these variables too; accept only canonical profile paths.
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
    const launcher = path.join(state, "bin", "openclaw");
    const existing = await lstatIfExists(launcher);
    if (
      existing &&
      (!existing.isFile() || !(await fs.readFile(launcher, "utf8")).startsWith(signature))
    ) {
      warn("Keeping existing terminal CLI at " + launcher + "; this Gateway: " + contextual);
      return;
    }
    const sqlite = command.environment?.OPENCLAW_SQLITE_LIBRARY?.trim();
    const sqliteLine = sqlite ? `export OPENCLAW_SQLITE_LIBRARY=${quoteCliArg(sqlite)}\n` : "";
    const shim = `${signature}export OPENCLAW_PROFILE="\${OPENCLAW_PROFILE:-${profile}}"\n${sqliteLine}exec ${prefix.map(quoteCliArg).join(" ")} "$@"\n`;
    await fs.mkdir(path.dirname(launcher), { recursive: true });
    if (!existing) {
      await fs.writeFile(launcher, shim, { flag: "wx", mode: 0o755 });
    } else if ((await fs.readFile(launcher, "utf8")) !== shim) {
      await fs.writeFile(launcher, shim, { mode: 0o755 });
    }
    await fs.chmod(launcher, 0o755);

    const defaultBin = path.join(home, ".openclaw", "bin");
    const terminal = path.join(defaultBin, "openclaw");
    if (launcher !== terminal) {
      const selected = await lstatIfExists(terminal);
      if (selected) {
        if (!selected.isSymbolicLink() || (await fs.readlink(terminal)) !== launcher) {
          warn("Terminal default unchanged; this Gateway: " + launcher);
          return;
        }
      } else {
        // Configuration establishes selection even when a Gateway is offline. Do not probe services.
        const others = (await fs.readdir(home)).filter(
          (name) =>
            (name === ".openclaw" || name.startsWith(".openclaw-")) &&
            path.join(home, name) !== state,
        );
        for (const name of others) {
          try {
            await fs.lstat(path.join(home, name, "openclaw.json"));
            warn(
              "Terminal default unchanged: another profile is configured; this Gateway: " +
                launcher,
            );
            return;
          } catch (error) {
            if (!isMissingPathError(error)) {
              throw error;
            }
          }
        }
        await fs.mkdir(defaultBin, { recursive: true });
        await fs.symlink(launcher, terminal); // Exclusive: never replace an operator's command.
      }
    }
    await installShellPath({ home, bin: defaultBin, env, warn });
  } catch (error) {
    warn(
      "Gateway installed, but terminal CLI setup failed: " +
        String(error) +
        "; this Gateway: " +
        contextual,
    );
  }
}

async function installShellPath(params: {
  home: string;
  bin: string;
  env: NodeJS.ProcessEnv;
  warn: (message: string) => void;
}) {
  const { home, bin, env, warn } = params;
  const exists = async (name: string) =>
    fs.lstat(path.join(home, name)).then(
      () => true,
      () => false,
    );
  const bashLogin = (await exists(".bash_profile"))
    ? ".bash_profile"
    : (await exists(".bash_login"))
      ? ".bash_login"
      : ".profile";
  const fish = ".config/fish/conf.d/openclaw.fish";
  const shell = path.basename(env.SHELL ?? "/bin/sh");
  const primary: string[] =
    shell === "bash"
      ? [".bashrc", bashLogin]
      : shell === "zsh"
        ? [".zshrc", ".zprofile"]
        : shell === "fish"
          ? [fish]
          : shell === "sh"
            ? [".profile"]
            : [];
  if (!primary.length) {
    warn("Terminal CLI installed; add " + bin + " to PATH for " + shell + ".");
    return;
  }
  const candidates = [".bashrc", bashLogin, ".zshrc", ".zprofile", fish];
  const targets = new Set([
    ...primary,
    ...(
      await Promise.all(candidates.map(async (name) => ((await exists(name)) ? name : undefined)))
    ).filter((name): name is string => name !== undefined),
  ]);
  const fishPath = "'" + bin.replaceAll("\\", "\\\\").replaceAll("'", "\\'") + "'";
  for (const target of targets) {
    const file = path.join(home, target);
    try {
      const resolved = resolvePathViaExistingAncestorSync(file);
      const relative = path.relative(await fs.realpath(home), resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("shell file points outside HOME");
      }
      const attrs = await fs.stat(resolved).catch((error: unknown) => {
        if (isMissingPathError(error)) {
          return undefined;
        }
        throw error;
      });
      if (attrs && (!attrs.isFile() || attrs.uid !== process.getuid?.())) {
        throw new Error("shell file is not user-owned");
      }
      const current = attrs ? await fs.readFile(resolved, "utf8") : "";
      const line =
        target === fish
          ? "fish_add_path -- " + fishPath
          : "export PATH=" + quoteCliArg(bin) + ':"$PATH"';
      if (current.split("\n")[0] === line) {
        continue;
      }
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(
        resolved,
        line +
          "\n" +
          current
            .split("\n")
            .filter((value) => value !== line)
            .join("\n"),
        { mode: attrs?.mode ?? 0o644 },
      );
    } catch (error) {
      warn(
        "Shell PATH setup skipped " +
          file +
          ": " +
          String(error) +
          "; add " +
          bin +
          " to PATH manually.",
      );
    }
  }
}
