// ClawHub release candidate producer tests cover blocked script evidence output.
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
const modelCases: Array<
  [
    name: string,
    expectedModel: string | null,
    model?: string,
    windowsModel?: string,
    platform?: string,
    expectedProvider?: string,
    expectedModelName?: string | null,
  ]
> = [
  ["default platforms and model", defaultModel],
  ["explicit all platforms", defaultModel, undefined, undefined, "all"],
  ["general model override", general, general],
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
  ["provider identity: mixed providers", null, general, customWindows, "linux,windows"],
  [
    "provider identity: Windows-first mixed providers",
    null,
    general,
    customWindows,
    "windows,linux",
  ],
  [
    "provider identity: arbitrary common provider",
    null,
    customGeneral,
    customWindows,
    "linux,windows",
    "custom",
  ],
  [
    "provider identity: Windows-first arbitrary common provider",
    null,
    customGeneral,
    customWindows,
    "windows,linux",
    "custom",
  ],
  [
    "provider identity: additional model slashes",
    "custom/nested/model",
    "custom/nested/model",
    undefined,
    undefined,
    "custom",
    "nested/model",
  ],
  [
    "provider identity: padded valid provider parts",
    null,
    "  openai/general  ",
    " openai/windows ",
    undefined,
    "openai",
  ],
  [
    "provider identity: normalized-equal raw-different models",
    null,
    "  openai/shared  ",
    shared,
    undefined,
    "openai",
  ],
  ["provider identity: provider case remains distinct", null, "OpenAI/general", windows],
  ["provider identity: identical trim-empty provider", null, " /model", undefined, "linux,macos"],
  ["provider identity: identical trim-empty model", null, "openai/   ", undefined, "linux,macos"],
  ["provider identity: identical empty provider", null, "/model"],
  ["provider identity: identical empty model", null, "openai/"],
  [
    "provider identity: identical bare alias",
    "alias",
    "alias",
    undefined,
    undefined,
    "live-frontier",
    null,
  ],
  [
    "provider identity: identical padded bare alias",
    "alias",
    " alias ",
    undefined,
    undefined,
    "live-frontier",
    null,
  ],
  ["provider identity: different bare aliases", null, "alias", "other-alias"],
  ["provider identity: bare and qualified refs", null, "alias", windows],
  [
    "provider identity: invalid qualified ref among valid refs",
    null,
    general,
    " /model",
    "linux,windows",
  ],
  [
    "provider identity: Windows-first invalid qualified ref",
    null,
    general,
    " /model",
    "windows,linux",
  ],
  ["provider identity: empty provider among valid refs", null, "/model", windows],
  ["provider identity: empty model among valid refs", null, "openai/", windows],
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
    const evidencePath = path.join(artifactBase, "qa-evidence.json");
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(evidencePath, "utf8")),
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
