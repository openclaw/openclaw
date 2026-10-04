// Doctor contract API fast-path tests cover lightweight channel doctor contract loading.
import { describe, expect, it, vi } from "vitest";

const { loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock } = vi.hoisted(() => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock: vi.fn(
    ({
      artifactCandidates,
      dirName,
    }: {
      artifactCandidates: readonly string[];
      dirName: string;
    }) => {
      if (!artifactCandidates.includes("doctor-contract-api.js")) {
        return null;
      }
      if (dirName === "discord") {
        return {
          legacyConfigRules: [
            {
              path: ["channels", "discord", "voice", "tts"],
              message: "legacy discord rule",
            },
          ],
        };
      }
      if (dirName === "whatsapp") {
        return {
          legacyConfigRules: [],
        };
      }
      return null;
    },
  ),
}));

vi.mock("../../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync:
    loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock,
}));

import { loadBundledChannelDoctorContractApi } from "./doctor-contract-api.js";

describe("channel doctor contract api fast path", () => {
  it("prefers the explicit doctor contract artifact for bundled channels", () => {
    const api = loadBundledChannelDoctorContractApi("discord");

    expect(api?.legacyConfigRules).toEqual([
      {
        path: ["channels", "discord", "voice", "tts"],
        message: "legacy discord rule",
      },
    ]);
    expect(loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock).toHaveBeenCalledWith({
      dirName: "discord",
      artifactCandidates: ["doctor-contract-api.js"],
    });
  });

  it("treats empty explicit doctor contract rules as authoritative", () => {
    const api = loadBundledChannelDoctorContractApi("whatsapp");

    expect(api?.legacyConfigRules).toStrictEqual([]);
    expect(loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock).toHaveBeenCalledWith({
      dirName: "whatsapp",
      artifactCandidates: ["doctor-contract-api.js"],
    });
    expect(loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock).not.toHaveBeenCalledWith({
      dirName: "whatsapp",
      artifactCandidates: ["contract-api.js"],
    });
  });

  it("does not fall back to the broad contract-api artifact when the doctor artifact is missing", () => {
    const api = loadBundledChannelDoctorContractApi("missing");

    expect(api).toBeUndefined();
    expect(loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock).toHaveBeenCalledWith({
      dirName: "missing",
      artifactCandidates: ["doctor-contract-api.js"],
    });
    expect(loadBundledPluginPublicArtifactModuleFromCandidatesSyncMock).not.toHaveBeenCalledWith({
      dirName: "missing",
      artifactCandidates: ["contract-api.js"],
    });
  });
});
