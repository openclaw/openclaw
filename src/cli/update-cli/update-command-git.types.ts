import type { ResolvedGlobalInstallTarget } from "../../infra/update-global.js";

export type GitInstallRelocation = {
  directory: string;
  installTarget: ResolvedGlobalInstallTarget;
  assertCurrent: () => Promise<void>;
};
