import { describe, expect, it } from "vitest";
import {
  getOfficialExternalPluginCatalogEntry,
  getOfficialExternalPluginCatalogEntryForPackage,
  resolveOfficialExternalPluginInstall,
} from "./official-external-plugin-catalog.js";

describe("official AgentMail catalog entry", () => {
  it("discovers AgentMail through its official ClawHub package without endorsing an npm namesake", () => {
    const entry = getOfficialExternalPluginCatalogEntry("agentmail");
    if (!entry) {
      throw new Error("Expected AgentMail in the official external channel catalog");
    }
    expect(getOfficialExternalPluginCatalogEntryForPackage("@agentmail/agentmail")).toBe(entry);
    expect(entry.kind).toBe("channel");
    expect(entry.openclaw?.channel).toMatchObject({
      configuredState: { env: { anyOf: ["AGENTMAIL_API_KEY"] } },
      docsPath: "https://www.agentmail.to/docs/integrations/openclaw",
      exposure: { docs: false },
    });
    expect(resolveOfficialExternalPluginInstall(entry)).toEqual({
      clawhubSpec: "clawhub:@agentmail/agentmail@0.2.1",
      expectedIntegrity: "sha256:155221cec38673a39bc27629f9f6ec87567ce4e37b7fa619ec4b1f7ca3d28730",
      defaultChoice: "clawhub",
      minHostVersion: ">=2026.8.1-beta.2",
      allowInvalidConfigRecovery: true,
    });
  });
});
