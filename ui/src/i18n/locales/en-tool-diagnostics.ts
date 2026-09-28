import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enToolDiagnostics = {
  agentTools: {
    off: "Off",
    unverified: "Unverified",
    sessionRestricted: "Denied by this session’s tool restrictions.",
    allowedByConfig: "Allowed by configuration",
    unsavedAvailability: "Save your changes to refresh the preview.",
    checked: "Based on",
    checkedLive: "Session preview",
    checkedLocal: "Local configuration",
    policySources: "Policy sources",
    profileInheritance: "Profile inheritance",
    profileGlobal: "Global",
    profileAgent: "Agent",
    profileAgentOverride: "Agent override",
    profileGlobalProvider: "Global provider",
    profileAgentProvider: "Agent provider",
    profileAgentProviderOverride: "Agent provider override",
    activeProfile: "Active",
  },
} satisfies TranslationMap;

export const registerToolDiagnosticsEnglish = Object.assign(
  () => Object.assign(en.agentTools, enToolDiagnostics.agentTools),
  { catalog: enToolDiagnostics },
);
