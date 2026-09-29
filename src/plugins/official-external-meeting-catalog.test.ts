import { expect, it } from "vitest";
import {
  getOfficialExternalPluginCatalogEntry,
  getOfficialExternalPluginCatalogManifest,
  resolveOfficialExternalPluginInstall,
} from "./official-external-plugin-catalog.js";

it.each([
  // Slack huddles needs the meeting-runtime ownership hook that ships after 2026.9.7.
  ["slack-huddles", "@openclaw/slack-huddles", "slack_huddles", "slack-huddle", ">=2026.9.8"],
  ["teams-meetings", "@openclaw/teams-meetings", "teams_meetings", "teams", ">=2026.7.2"],
  ["zoom-meetings", "@openclaw/zoom-meetings", "zoom_meetings", "zoom", ">=2026.7.2"],
] as const)(
  "lists %s as an official external meeting plugin",
  (id, npmSpec, toolId, transcriptSourceProviderId, minHostVersion) => {
    const entry = getOfficialExternalPluginCatalogEntry(id);
    if (!entry) {
      throw new Error(`Expected external meeting plugin ${id}`);
    }
    const contracts = getOfficialExternalPluginCatalogManifest(entry)?.contracts;

    expect(resolveOfficialExternalPluginInstall(entry)).toEqual({
      clawhubSpec: `clawhub:${npmSpec}`,
      npmSpec,
      defaultChoice: "npm",
      minHostVersion,
    });
    expect(contracts?.tools).toEqual([toolId]);
    expect(contracts?.transcriptSourceProviders).toEqual([transcriptSourceProviderId]);
  },
);
