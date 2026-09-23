// ClawHub release candidate producer tests cover blocked script evidence output.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateQaEvidenceSummaryJson } from "../../../../extensions/qa-lab/test-api.js";
import { runClawHubReleaseCandidateInstallProducer } from "./clawhub-release-candidate-install.js";

const tempRoots: string[] = [];
const modelCases: {
  name: string;
  platform?: string;
  model?: string;
  windowsModel?: string;
  expectedModel: string | null;
  expectedModelName?: string | null;
  expectedProvider?: string;
}[] = [
  { name: "default platforms and model", expectedModel: "openai/gpt-5.6-luna" },
  { name: "explicit all platforms", platform: "all", expectedModel: "openai/gpt-5.6-luna" },
  { name: "general model override", model: "openai/general", expectedModel: "openai/general" },
  {
    name: "Windows model override",
    platform: "windows",
    model: "openai/general",
    windowsModel: "openai/windows",
    expectedModel: "openai/windows",
  },
  {
    name: "unselected Windows override",
    platform: "macos",
    windowsModel: "openai/windows",
    expectedModel: "openai/gpt-5.6-luna",
  },
  {
    name: "selected non-Windows platforms",
    platform: "macos,linux",
    model: "openai/general",
    windowsModel: "openai/windows",
    expectedModel: "openai/general",
  },
  {
    name: "matching platform models",
    model: "openai/shared",
    windowsModel: "openai/shared",
    expectedModel: "openai/shared",
  },
  {
    name: "different platform models",
    model: "openai/general",
    windowsModel: "openai/windows",
    expectedModel: null,
    expectedProvider: "openai",
  },
  {
    name: "Windows-first different platform models",
    platform: "windows,linux",
    model: "openai/general",
    windowsModel: "openai/windows",
    expectedModel: null,
    expectedProvider: "openai",
  },
  { name: "invalid platform", platform: "unknown", expectedModel: null },
  { name: "duplicate platform", platform: "linux,linux", expectedModel: null },
  { name: "blank platform", platform: " ", expectedModel: null },
  { name: "blank model", platform: "linux", model: "   ", expectedModel: null },
  {
    name: "Windows blank model fallback",
    platform: "windows",
    model: "   ",
    windowsModel: "   ",
    expectedModel: "openai/gpt-5.6-luna",
  },
  {
    name: "general model evidence normalization",
    model: "  openai/general  ",
    expectedModel: "openai/general",
  },
  {
    name: "Windows model whitespace normalization",
    platform: "windows",
    windowsModel: "  openai/windows  ",
    expectedModel: "openai/windows",
  },
  {
    name: "provider identity: mixed providers",
    platform: "linux,windows",
    model: "openai/general",
    windowsModel: "custom/windows",
    expectedModel: null,
  },
  {
    name: "provider identity: Windows-first mixed providers",
    platform: "windows,linux",
    model: "openai/general",
    windowsModel: "custom/windows",
    expectedModel: null,
  },
  {
    name: "provider identity: arbitrary common provider",
    platform: "linux,windows",
    model: "custom/general",
    windowsModel: "custom/windows",
    expectedModel: null,
    expectedProvider: "custom",
  },
  {
    name: "provider identity: Windows-first arbitrary common provider",
    platform: "windows,linux",
    model: "custom/general",
    windowsModel: "custom/windows",
    expectedModel: null,
    expectedProvider: "custom",
  },
  {
    name: "provider identity: additional model slashes",
    model: "custom/nested/model",
    expectedModel: "custom/nested/model",
    expectedModelName: "nested/model",
    expectedProvider: "custom",
  },
  {
    name: "provider identity: padded valid provider parts",
    model: "  openai/general  ",
    windowsModel: " openai/windows ",
    expectedModel: null,
    expectedProvider: "openai",
  },
  {
    name: "provider identity: normalized-equal raw-different models",
    model: "  openai/shared  ",
    windowsModel: "openai/shared",
    expectedModel: null,
    expectedProvider: "openai",
  },
  {
    name: "provider identity: provider case remains distinct",
    model: "OpenAI/general",
    windowsModel: "openai/windows",
    expectedModel: null,
  },
  {
    name: "provider identity: identical trim-empty provider",
    platform: "linux,macos",
    model: " /model",
    expectedModel: null,
  },
  {
    name: "provider identity: identical trim-empty model",
    platform: "linux,macos",
    model: "openai/   ",
    expectedModel: null,
  },
  {
    name: "provider identity: identical empty provider",
    model: "/model",
    expectedModel: null,
  },
  {
    name: "provider identity: identical empty model",
    model: "openai/",
    expectedModel: null,
  },
  {
    name: "provider identity: identical bare alias",
    model: "alias",
    expectedModel: "alias",
    expectedModelName: null,
    expectedProvider: "live-frontier",
  },
  {
    name: "provider identity: identical padded bare alias",
    model: " alias ",
    expectedModel: "alias",
    expectedModelName: null,
    expectedProvider: "live-frontier",
  },
  {
    name: "provider identity: different bare aliases",
    model: "alias",
    windowsModel: "other-alias",
    expectedModel: null,
  },
  {
    name: "provider identity: bare and qualified refs",
    model: "alias",
    windowsModel: "openai/windows",
    expectedModel: null,
  },
  {
    name: "provider identity: invalid qualified ref among valid refs",
    platform: "linux,windows",
    model: "openai/general",
    windowsModel: " /model",
    expectedModel: null,
  },
  {
    name: "provider identity: Windows-first invalid qualified ref",
    platform: "windows,linux",
    model: "openai/general",
    windowsModel: " /model",
    expectedModel: null,
  },
  {
    name: "provider identity: empty provider among valid refs",
    model: "/model",
    windowsModel: "openai/windows",
    expectedModel: null,
  },
  {
    name: "provider identity: empty model among valid refs",
    model: "openai/",
    windowsModel: "openai/windows",
    expectedModel: null,
  },
];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
  vi.unstubAllEnvs();
});

describe("ClawHub release candidate install producer", () => {
  for (const testCase of modelCases) {
    it(`writes blocked evidence with ${testCase.name}`, async () => {
      const { platform, model, windowsModel, expectedModel, expectedModelName, expectedProvider } =
        testCase;
      const artifactBase = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-clawhub-release-evidence-"),
      );
      tempRoots.push(artifactBase);
      const missingTarballEnv = "OPENCLAW_TEST_MISSING_RELEASE_CANDIDATE_TARBALL";
      vi.stubEnv(missingTarballEnv, "");
      vi.stubEnv("OPENAI_API_KEY", "");
      vi.stubEnv("OPENCLAW_PARALLELS_OPENAI_MODEL", model);
      vi.stubEnv("OPENCLAW_PARALLELS_WINDOWS_OPENAI_MODEL", windowsModel);

      const result = await runClawHubReleaseCandidateInstallProducer({
        artifactBase,
        buildFromCheckout: false,
        platform,
        repoRoot: process.cwd(),
        tarballEnv: missingTarballEnv,
      });
      const evidencePath = path.join(artifactBase, "qa-evidence.json");
      const evidence = validateQaEvidenceSummaryJson(
        JSON.parse(await fs.readFile(evidencePath, "utf8")),
      );
      expect(result).toEqual(evidence);
      expect(evidence.entries).toHaveLength(1);
      expect(evidence.entries[0]).toMatchObject({
        execution: {
          artifacts: [{ kind: "log", path: "parallels-npm-update.log", source: "script" }],
        },
        result: {
          status: "blocked",
          failure: {
            reason: `${missingTarballEnv} is not set; provide a candidate .tgz or pass --build-from-checkout.`,
          },
        },
      });
      expect(await fs.readFile(path.join(artifactBase, "parallels-npm-update.log"), "utf8")).toBe(
        "",
      );
      expect(evidence.entries[0]?.execution?.provider).toMatchObject({
        id: expectedProvider ?? (expectedModel === null ? "live-frontier" : "openai"),
        live: true,
        auth: "live-frontier",
        model: {
          ref: expectedModel,
          ...(expectedModel === null ? { name: null } : {}),
          ...(expectedModelName !== undefined ? { name: expectedModelName } : {}),
        },
      });
      expect(evidence.entries[0]?.execution?.provider).not.toHaveProperty("fixture");
    });
  }
});
