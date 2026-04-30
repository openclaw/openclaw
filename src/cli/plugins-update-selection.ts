import type { HookInstallRecord } from "../config/types.hooks.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { extractInstalledNpmHookPackageName } from "./plugins-install-records.js";

export { resolvePluginUpdateSelection } from "../plugins/plugins-update-selection.js";

export function resolveHookPackUpdateSelection(params: {
  installs: Record<string, HookInstallRecord>;
  rawId?: string;
  all?: boolean;
}): { hookIds: string[]; specOverrides?: Record<string, string> } {
  if (params.all) {
    return { hookIds: Object.keys(params.installs) };
  }
  if (!params.rawId) {
    return { hookIds: [] };
  }
  if (params.rawId in params.installs) {
    return { hookIds: [params.rawId] };
  }

  const parsedSpec = parseRegistryNpmSpec(params.rawId);
  if (!parsedSpec || parsedSpec.selectorKind === "none") {
    return { hookIds: [] };
  }

  const matches = Object.entries(params.installs).filter(([, install]) => {
    return extractInstalledNpmHookPackageName(install) === parsedSpec.name;
  });
  if (matches.length !== 1) {
    return { hookIds: [] };
  }

  const [hookId] = matches[0];
  if (!hookId) {
    return { hookIds: [] };
  }
  return {
    hookIds: [hookId],
    specOverrides: {
      [hookId]: parsedSpec.raw,
    },
  };
}
