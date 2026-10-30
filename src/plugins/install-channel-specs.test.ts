import { beforeEach, expect, it, vi } from "vitest";
import { resolveNpmSpecMetadata } from "../infra/install-source-utils.js";
import { resolveNpmIntegrityDriftWithDefaultMessage } from "../infra/npm-integrity.js";
import {
  installWithSourceFallback,
  resolveClawHubInstallSpecsForUpdateChannel,
  resolveNpmInstallSpecsForUpdateChannel,
} from "./install-channel-specs.js";

vi.mock("../infra/install-source-utils.js", () => ({ resolveNpmSpecMetadata: vi.fn() }));
beforeEach(() => {
  vi.mocked(resolveNpmSpecMetadata).mockReset();
});

const npmName = "@openclaw/codex";
const clawHubName = "@openclaw/discord";
const missingPackage = { ok: false as const, error: "Package not found on npm" };
function npmMetadata(version: string) {
  const resolvedSpec = npmName + "@" + version;
  return { name: npmName, version, resolvedSpec, integrity: "sha512-" + version };
}
type NpmParams = Parameters<typeof resolveNpmInstallSpecsForUpdateChannel>[0];
async function expectNpm(params: NpmParams, installSpec = params.spec) {
  const result = await resolveNpmInstallSpecsForUpdateChannel(params);
  expect(result).toEqual({ installSpec, recordSpec: params.spec });
}
function officialNpm(
  spec: string,
  options: Omit<NpmParams, "spec" | "officialPackageName">,
): NpmParams {
  return { spec, officialPackageName: npmName, ...options };
}

it.each(["notarget", "etarget"])(
  "keeps integrity refusal terminal for package %s",
  async (name) => {
    const spec = "@synthetic/" + name + "@1.0.0";
    const refusal = await resolveNpmIntegrityDriftWithDefaultMessage({
      spec,
      expectedIntegrity: "sha512-" + Buffer.alloc(64, 1).toString("base64"),
      resolution: {
        resolvedSpec: spec,
        integrity: "sha512-" + Buffer.alloc(64, 2).toString("base64"),
      },
      onIntegrityDrift: () => false,
    });
    expect(refusal.error).toContain("aborted: npm package integrity drift");
    const attempted: string[] = [];
    const result = await installWithSourceFallback({
      sources: [
        { source: "npm", spec },
        { source: "clawhub", spec: "clawhub:" + name + "@1.0.0" },
      ],
      install: async ({ source }) => {
        attempted.push(source);
        return source === "npm" ? { ok: false, error: refusal.error } : { ok: true };
      },
      result: (attempt) => attempt,
      onFallback: () => {},
    });
    expect(result.attempt).toEqual({ ok: false, error: refusal.error });
    expect(attempted).toEqual(["npm"]);
  },
);

it.each([
  ["extended-stable", false, "2026.7.33", "2026.7.33"],
  ["stable", true, "2026.8.1", "2026.8.1"],
  ["stable", true, "2026.7.1-2", "2026.7.1"],
  ["extended-stable", true, "2026.7.1-2", "2026.7.1"],
] as const)(
  "pins %s (bound=%s, core=%s) to %s",
  async (updateChannel, versionBoundToCore, coreVersion, version) => {
    for (const spec of [npmName, npmName + "@latest"]) {
      await expectNpm(
        officialNpm(spec, { updateChannel, versionBoundToCore, coreVersion }),
        npmName + "@" + version,
      );
    }
    expect(resolveNpmSpecMetadata).not.toHaveBeenCalled();
  },
);

it.each([
  [npmName + "@2026.6.33", "beta", npmName, "2026.8.1-beta.3"],
  [npmName + "@next", "beta", npmName, "2026.8.1-beta.3"],
  [npmName + "@^2026.6.0", "beta", npmName, "2026.8.1-beta.3"],
  ["@acme/discord", "extended-stable", clawHubName, "2026.7.33"],
] as const)(
  "preserves explicit or third-party %s on %s",
  async (spec, updateChannel, officialPackageName, coreVersion) => {
    await expectNpm({ spec, updateChannel, officialPackageName, coreVersion });
    expect(resolveNpmSpecMetadata).not.toHaveBeenCalled();
  },
);

it("requires an authoritative extended-stable core version", async () => {
  const params = officialNpm(npmName, { updateChannel: "extended-stable" });
  await expect(resolveNpmInstallSpecsForUpdateChannel(params)).rejects.toThrow(
    "requires an exact core version",
  );
});

it.each([
  ["2026.9.1-beta.1", "2026.9.2", "2026.9.2", "latest", "tag-behind-latest"],
  ["2026.9.3-beta.1", "2026.9.2", "2026.9.3-beta.1", "beta", undefined],
  ["2026.9.2", "2026.9.2", "2026.9.2", "beta", undefined],
  [null, "2026.9.2", "2026.9.2", "latest", undefined],
  ["2026.9.3-beta.1", null, "2026.9.3-beta.1", "beta", undefined],
] as const)(
  "selects beta=%s latest=%s -> %s (%s, %s)",
  async (beta, latest, version, tag, reason) => {
    vi.mocked(resolveNpmSpecMetadata).mockImplementation(async ({ spec }) => {
      const selected = spec.endsWith("@beta") ? beta : latest;
      return selected ? { ok: true, metadata: npmMetadata(selected) } : missingPackage;
    });
    for (const spec of [npmName, npmName + "@latest", npmName + "@beta"]) {
      const params = officialNpm(spec, {
        updateChannel: "beta",
        coreVersion: "2026.9.1-beta.1",
        versionBoundToCore: true,
      });
      expect(await resolveNpmInstallSpecsForUpdateChannel(params)).toEqual({
        installSpec: npmName + "@" + version,
        recordSpec: spec,
        npmResolution: npmMetadata(version),
        channelTag: tag,
        ...(reason ? { channelReason: reason } : {}),
      });
    }
  },
);

it("leaves missing packages to the install owner's source fallback", async () => {
  vi.mocked(resolveNpmSpecMetadata).mockResolvedValue(missingPackage);
  await expectNpm({ spec: npmName + "@beta", updateChannel: "beta" }, npmName + "@latest");
});

it.each(["beta", "latest"] as const)(
  "does not install the other tag when %s metadata fails",
  async (failedTag) => {
    vi.mocked(resolveNpmSpecMetadata).mockImplementation(async ({ spec }) =>
      spec.endsWith("@" + failedTag)
        ? { ok: false, category: "metadata-env", error: "Registry unavailable" }
        : { ok: true, metadata: { name: npmName, version: "2026.9.1-beta.1" } },
    );
    await expect(
      resolveNpmInstallSpecsForUpdateChannel({ spec: npmName, updateChannel: "beta" }),
    ).rejects.toThrow("Registry unavailable");
  },
);
const clawSpec = "clawhub:" + clawHubName;
it.each([
  ["stable", false, false, true, undefined, undefined, false],
  ["stable", false, true, true, undefined, "2026.7.33", true],
  ["stable", true, false, true, undefined, "2026.7.33", false],
  ["beta", false, false, true, undefined, "beta", true],
  ["extended-stable", false, false, true, undefined, "2026.7.33", false],
  ["stable", true, false, true, "2026.6.33", "2026.6.33", false],
  ["beta", true, false, true, "next", "next", false],
  ["extended-stable", true, false, true, "next", "next", false],
  ["stable", false, false, false, undefined, undefined, false],
  ["extended-stable", false, false, false, undefined, undefined, false],
] as const)(
  "ClawHub %s (bound=%s, preferCore=%s, official=%s, selector=%s) -> %s",
  (
    updateChannel,
    versionBoundToCore,
    preferCoreVersion,
    official,
    selector,
    expected,
    fallback,
  ) => {
    for (const suffix of selector ? [selector] : [undefined, "latest"]) {
      const spec = suffix ? clawSpec + "@" + suffix : clawSpec;
      const installSpec = expected ? clawSpec + "@" + expected : spec;
      expect(
        resolveClawHubInstallSpecsForUpdateChannel({
          spec,
          updateChannel,
          versionBoundToCore,
          preferCoreVersion,
          officialPackageName: official ? clawHubName : undefined,
          coreVersion: "2026.7.33",
        }),
      ).toEqual({
        installSpec,
        recordSpec: spec,
        ...(fallback ? { fallbackSpec: spec, fallbackLabel: installSpec } : {}),
      });
    }
  },
);
