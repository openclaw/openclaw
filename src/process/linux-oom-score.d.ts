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
export declare const CHILD_OOM_SCORE_ADJ_ENV_KEY = "OPENCLAW_CHILD_OOM_SCORE_ADJ";
export type OomWrapOptions = {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    shellAvailable?: () => boolean;
};
export type OomScoreAdjustedSpawn = {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv | undefined;
    wrapped: boolean;
};
export declare function prepareOomScoreAdjustedSpawn(command: string, args?: readonly string[], options?: OomWrapOptions): OomScoreAdjustedSpawn;
export declare function wrapArgvForChildOomScoreRaise(argv: readonly string[], options?: OomWrapOptions): string[];
/**
 * Returns `baseEnv` with shell-init keys stripped when argv will be wrapped.
 * Unchanged (including `undefined`) when no wrap applies, so non-Linux and
 * opted-out paths keep exact inherited-env semantics.
 */
export declare function hardenedEnvForChildOomWrap(baseEnv: NodeJS.ProcessEnv | undefined, options?: OomWrapOptions): NodeJS.ProcessEnv | undefined;
