export type ExecAllowlistEntry = {
  id?: string;
  pattern: string;
  source?: "allow-always";
  commandText?: string;
  argPattern?: string;
  lastUsedAt?: number;
  lastUsedCommand?: string;
  lastResolvedPath?: string;
};

/**
 * A denylist entry blocks a command pattern regardless of security mode.
 * Even in `security: "full"` mode, denylisted executables are blocked.
 * Pattern matches executable basename (e.g. "pnpm" matches /usr/local/bin/pnpm).
 * Path-scoped patterns (containing /) match the resolved path prefix.
 */
export type ExecDenylistEntry = {
  id?: string;
  pattern: string;
  reason?: string;
};
