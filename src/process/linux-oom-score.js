import fs from "node:fs";
/**
 * On Linux, children spawned by a long-lived parent (e.g., the gateway) inherit
 * the parent's `oom_score_adj`. Under cgroup memory pressure the kernel tends
 * to pick the largest-RSS process as the OOM victim, which is usually the
 * gateway rather than its transient workers. See issue #70404.
 *
 * Since Linux 2.6.20 any unprivileged process may voluntarily *raise* its own
 * `oom_score_adj` without `CAP_SYS_RESOURCE`. We exploit that by wrapping the
 * child argv in a tiny `/bin/sh` shim that raises the score in the post-fork
 * child and then `exec`s the real command, so there is no extra long-lived
 * shell process and no change to the final process identity.
 *
 * Opt out per-process by setting `OPENCLAW_CHILD_OOM_SCORE_ADJ=0` (also
 * accepts `false`/`no`/`off`). Callers may also provide the key via
 * `params.env` for per-child overrides.
 */
export const CHILD_OOM_SCORE_ADJ_ENV_KEY = "OPENCLAW_CHILD_OOM_SCORE_ADJ";
const OOM_SCORE_WRAP_SHELL = "/bin/sh";
const OOM_SCORE_WRAP_SCRIPT = 'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; exec "$0" "$@"';
// Env keys that can cause /bin/sh (especially bash invoked as sh) to source
// caller-influenced startup files before the final `exec`. Stripped when we
// wrap so the shim can't become an env-controlled code-exec primitive.
const SHELL_INIT_ENV_KEYS = ["BASH_ENV", "ENV", "CDPATH"];
function isDisabled(value) {
    switch (value?.trim().toLowerCase()) {
        case "0":
        case "false":
        case "no":
        case "off":
            return true;
        default:
            return false;
    }
}
let cachedShellAvailable = null;
function defaultShellAvailable() {
    if (cachedShellAvailable !== null) {
        return cachedShellAvailable;
    }
    try {
        cachedShellAvailable = fs.statSync(OOM_SCORE_WRAP_SHELL).isFile();
    }
    catch {
        cachedShellAvailable = false;
    }
    return cachedShellAvailable;
}
function shouldWrapChildForOomScore(options) {
    const platform = options?.platform ?? process.platform;
    if (platform !== "linux") {
        return false;
    }
    const env = options?.env ?? process.env;
    if (isDisabled(env[CHILD_OOM_SCORE_ADJ_ENV_KEY])) {
        return false;
    }
    return (options?.shellAvailable ?? defaultShellAvailable)();
}
function isWrapped(command, args) {
    return command === OOM_SCORE_WRAP_SHELL && args[0] === "-c" && args[1] === OOM_SCORE_WRAP_SCRIPT;
}
function canUseShellExecCommand(command) {
    // POSIX sh implementations such as dash do not support `exec --`. A command
    // starting with "-" could be parsed as an exec option, so keep that rare
    // shape on the original direct-spawn path instead of wrapping it.
    return !command.startsWith("-");
}
function hardenShellEnv(baseEnv) {
    const next = { ...(baseEnv ?? process.env) };
    for (const key of SHELL_INIT_ENV_KEYS) {
        delete next[key];
    }
    return next;
}
export function prepareOomScoreAdjustedSpawn(command, args = [], options) {
    const copy = [...args];
    if (!command || !canUseShellExecCommand(command) || !shouldWrapChildForOomScore(options)) {
        return { command, args: copy, env: options?.env, wrapped: false };
    }
    if (isWrapped(command, copy)) {
        return { command, args: copy, env: hardenShellEnv(options?.env), wrapped: true };
    }
    return {
        command: OOM_SCORE_WRAP_SHELL,
        args: ["-c", OOM_SCORE_WRAP_SCRIPT, command, ...copy],
        env: hardenShellEnv(options?.env),
        wrapped: true,
    };
}
export function wrapArgvForChildOomScoreRaise(argv, options) {
    const copy = [...argv];
    if (copy.length === 0) {
        return copy;
    }
    const spawn = prepareOomScoreAdjustedSpawn(copy[0] ?? "", copy.slice(1), options);
    return [spawn.command, ...spawn.args];
}
/**
 * Returns `baseEnv` with shell-init keys stripped when argv will be wrapped.
 * Unchanged (including `undefined`) when no wrap applies, so non-Linux and
 * opted-out paths keep exact inherited-env semantics.
 */
export function hardenedEnvForChildOomWrap(baseEnv, options) {
    if (!shouldWrapChildForOomScore(options)) {
        return baseEnv;
    }
    return hardenShellEnv(baseEnv);
}
