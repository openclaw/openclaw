import type fs from "node:fs";
import type JSON5 from "json5";

export type ParseConfigJson5Result = { ok: true; parsed: unknown } | { ok: false; error: string };

export type ConfigSnapshotReadMeasure = <T>(name: string, run: () => T | Promise<T>) => Promise<T>;

export type ConfigIoDeps = {
  fs?: typeof fs;
  json5?: typeof JSON5;
  env?: NodeJS.ProcessEnv;
  lowerPrecedenceEnv?: Readonly<Record<string, string>>;
  homedir?: () => string;
  configPath?: string;
  logger?: Pick<typeof console, "error" | "warn">;
  measure?: ConfigSnapshotReadMeasure;
  suppressFutureVersionWarning?: boolean;
  observe?: boolean;
};

export type NormalizedConfigIoDeps = Required<ConfigIoDeps>;
