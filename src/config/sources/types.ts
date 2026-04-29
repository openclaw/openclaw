import type { ConfigFileSnapshot } from "../types.js";

export type ConfigSourceKind = "file" | "nacos";

export type ConfigSource = {
  kind: ConfigSourceKind;
  readSnapshot: () => Promise<ConfigFileSnapshot>;
  subscribe?: (onChange: () => void) => () => void;
  watchPath?: string | null;
};
