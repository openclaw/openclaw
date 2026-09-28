import type { Result } from "@openclaw/normalization-core/result";

/** The refresh owner consumes coverage and retirement, not a dependency's private registry. */
export type SkillsDirectoryWatcher = {
  readonly closed: boolean;
  readonly directories: ReadonlySet<string>;
  on(event: "ready", listener: () => void): unknown;
  on(event: "dirty", listener: () => void): unknown;
  on(event: "all", listener: (event: string, path: string) => void): unknown;
  on(event: "raw", listener: (event: string, path: unknown, details: unknown) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  close(): Promise<Result<void, unknown>>;
};
