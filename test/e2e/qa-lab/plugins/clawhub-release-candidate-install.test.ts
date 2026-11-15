import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { validateQaEvidenceSummaryJson } from "../../../../extensions/qa-lab/test-api.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { runClawHubReleaseCandidateInstallProducer } from "./clawhub-release-candidate-install.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const defaultModel = "openai/gpt-5.6-luna";
const general = "openai/general",
  windows = "openai/windows",
  shared = "openai/shared";
const customGeneral = "custom/general",
  customWindows = "custom/windows";
type ModelCase = [
  name: string,
  expectedModel: string | null,
  model?: string,
  windowsModel?: string,
  platform?: string,
  expectedProvider?: string,
  expectedModelName?: string | null,
];
const providerCase = (
  name: string,
  model: string,
  windowsModel?: string,
  platform?: string,
  provider?: string,
): ModelCase => [`provider identity: ${name}`, null, model, windowsModel, platform, provider];
const modelCases: ModelCase[] = [
  ["default platforms and model", defaultModel],
  ["Windows model override", windows, general, windows, "windows"],
  ["unselected Windows override", defaultModel, undefined, windows, "macos"],
  ["selected non-Windows platforms", general, general, windows, "macos,linux"],
  ["matching platform models", shared, shared, shared],
  ["different platform models", null, general, windows, undefined, "openai"],
  ["Windows-first different platform models", null, general, windows, "windows,linux", "openai"],
  ["invalid platform", null, undefined, undefined, "unknown"],
  ["duplicate platform", null, undefined, undefined, "linux,linux"],
  ["blank platform", null, undefined, undefined, " "],
  ["blank model", null, "   ", undefined, "linux"],
  ["Windows blank model fallback", defaultModel, "   ", "   ", "windows"],
  ["general model evidence normalization", general, "  openai/general  "],
  ["Windows model whitespace normalization", windows, undefined, "  openai/windows  ", "windows"],
  providerCase("mixed providers", general, customWindows, "linux,windows"),
  providerCase("Windows-first mixed providers", general, customWindows, "windows,linux"),
  providerCase("common provider", customGeneral, customWindows, "linux,windows", "custom"),
  providerCase("Windows-first custom", customGeneral, customWindows, "windows,linux", "custom"),
  [
    "provider identity: additional model slashes",
    "custom/nested/model",
    "custom/nested/model",
    undefined,
    undefined,
    "custom",
    "nested/model",
  ],
  providerCase("normalized-equal models", "  openai/shared  ", shared, undefined, "openai"),
  providerCase("provider case remains distinct", "OpenAI/general", windows),
  providerCase("identical trim-empty provider", " /model", undefined, "linux,macos"),
  providerCase("identical trim-empty model", "openai/   ", undefined, "linux,macos"),
  providerCase("identical empty provider", "/model"),
  providerCase("identical empty model", "openai/"),
  [
    "provider identity: identical bare alias",
    "alias",
    "alias",
    undefined,
    undefined,
    "live-frontier",
    null,
  ],
  providerCase("different bare aliases", "alias", "other-alias"),
  providerCase("bare and qualified refs", "alias", windows),
  providerCase("invalid qualified ref among valid refs", general, " /model", "linux,windows"),
  providerCase("Windows-first invalid qualified ref", general, " /model", "windows,linux"),
  providerCase("empty provider among valid refs", "/model", windows),
  providerCase("empty model among valid refs", "openai/", windows),
];
afterEach(() => vi.unstubAllEnvs());

for (const [
  name,
  expectedModel,
  model,
  windowsModel,
  platform,
  expectedProvider,
  expectedModelName,
] of modelCases) {
  it(`writes blocked evidence with ${name}`, async () => {
    const artifactBase = tempDirs.make("openclaw-clawhub-release-evidence-");
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
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(path.join(artifactBase, "qa-evidence.json"), "utf8")),
    );
    expect(result).toEqual(evidence);
    expect(evidence.entries).toMatchObject([
      {
        execution: {
          artifacts: [{ kind: "log", path: "parallels-npm-update.log", source: "script" }],
        },
        result: {
          status: "blocked",
          failure: {
            reason: `${missingTarballEnv} is not set; provide a candidate .tgz or pass --build-from-checkout.`,
          },
        },
      },
    ]);
    expect(await fs.readFile(path.join(artifactBase, "parallels-npm-update.log"), "utf8")).toBe("");
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
