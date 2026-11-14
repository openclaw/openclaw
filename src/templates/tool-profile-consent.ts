import { isToolAllowedByPolicyName } from "../agents/tool-policy-match.js";
import { expandToolGroups, resolveToolProfilePolicy } from "../agents/tool-policy-shared.js";
import type { TemplateOpenClawAgentSettings } from "./manifest-contract.js";

type TemplateToolSettings = NonNullable<TemplateOpenClawAgentSettings["tools"]>;
type TemplateToolProfileSelection = Omit<
  Pick<TemplateToolSettings, "profile" | "allow" | "alsoAllow" | "deny">,
  "profile"
> & { profile?: string };

export function isConcreteBundleMcpToolName(name: string): boolean {
  return name.length <= 64 && /^[A-Za-z][A-Za-z0-9_-]*__[A-Za-z][A-Za-z0-9_-]*$/u.test(name);
}

export function resolveTemplateToolProfileSnapshot(
  tools: TemplateToolProfileSelection,
): { allow: string[]; deny: string[] } | undefined {
  if (!tools.profile) {
    return undefined;
  }
  const profile = resolveToolProfilePolicy(tools.profile);
  if (!profile) {
    return undefined;
  }
  const profileAllow = expandToolGroups(profile.allow);
  const deny = expandToolGroups([...(profile.deny ?? []), ...(tools.deny ?? [])]);
  const explicitAllow = tools.allow
    ? profileAllow.includes("*")
      ? expandToolGroups(tools.allow)
      : Array.from(
          new Set([
            ...profileAllow.filter((tool) =>
              isToolAllowedByPolicyName(tool, { allow: tools.allow, deny }),
            ),
            ...(profileAllow.includes("bundle-mcp")
              ? tools.allow.filter(isConcreteBundleMcpToolName)
              : []),
          ]),
        )
    : undefined;
  return {
    allow:
      explicitAllow ?? expandToolGroups([...(profile.allow ?? []), ...(tools.alsoAllow ?? [])]),
    deny,
  };
}

export function materializeTemplateToolProfile(
  settings: TemplateOpenClawAgentSettings,
  options: { allowLegacyDynamicProfile?: boolean } = {},
): TemplateOpenClawAgentSettings {
  const tools = settings.tools;
  if (!tools) {
    return settings;
  }
  if (!tools.profile) {
    const allow = expandToolGroups(tools.allow);
    const deny = expandToolGroups(tools.deny);
    return {
      ...settings,
      tools: {
        ...(allow.length > 0 ? { profile: "full" as const, allow } : {}),
        ...(tools.alsoAllow ? { alsoAllow: expandToolGroups(tools.alsoAllow) } : {}),
        ...(deny.length > 0 ? { deny } : {}),
        ...(tools.fs ? { fs: tools.fs } : {}),
      },
    };
  }
  const snapshot = resolveTemplateToolProfileSnapshot(tools);
  if (!snapshot) {
    return settings;
  }
  if (tools.profile === "full" && !tools.allow) {
    throw new Error("Template full tool profile requires a bounded explicit allowlist.");
  }
  if (tools.allow && snapshot.allow.length === 0) {
    throw new Error("Template tool allowlist does not overlap the selected profile.");
  }
  const allow = options.allowLegacyDynamicProfile
    ? snapshot.allow.filter((grant) => grant !== "bundle-mcp")
    : snapshot.allow;
  if (allow.includes("bundle-mcp")) {
    throw new Error(
      "Template tool profiles containing bundle-mcp require an explicit bounded allowlist of concrete tool names.",
    );
  }
  if (allow.length === 0) {
    throw new Error("Legacy Template tool profile has no bounded authority to preserve.");
  }
  return {
    ...settings,
    tools: {
      profile: "full",
      allow,
      ...(snapshot.deny.length > 0 ? { deny: snapshot.deny } : {}),
      ...(tools.fs ? { fs: tools.fs } : {}),
    },
  };
}
