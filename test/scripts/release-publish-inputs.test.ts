import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReleasePublishInputs,
  resolveReleasePublishInputs,
} from "../../scripts/lib/release-publish-inputs.mjs";
import { createPluginSdkApiReleaseEvidence } from "../../scripts/plugin-sdk-api-release-evidence.mjs";

afterEach(() => vi.unstubAllGlobals());

function seal({
  fetchImpl,
  ...input
}: Parameters<typeof createReleasePublishInputs>[0] & { fetchImpl: typeof fetch }) {
  vi.stubGlobal("fetch", fetchImpl);
  return createReleasePublishInputs(input);
}

const targetSha = "a".repeat(40);
const workflowSha = "b".repeat(40);
const version = "2026.9.6";
function fixture(npmDistTag = "latest", packageName = "@openclaw/example") {
  const payload = { entrypointsAdded: ["new-surface"], entrypointsRemoved: [], exports: [] };
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return {
    manifest: {
      targetSha,
      publicationArtifacts: { npmPreflight: { producer: { workflowSha } } },
      sourceAdmission: {
        validationPurpose: "publish",
        publicationSelection: { npmDistTag },
        projection: { packages: [{ name: packageName, version, targets: ["npm"] }] },
      },
    },
    npmManifest: {
      releaseSha: targetSha,
      pluginSdkApi: createPluginSdkApiReleaseEvidence({
        baseRef: "v2026.9.5",
        baseSha: "c".repeat(40),
        headSha: targetSha,
        workflowSha,
        diff: { ...payload, digest },
      }),
    },
    digest,
  };
}

describe("sealed publication inputs", () => {
  it.each([
    { published: false, latest: "2026.9.5", decision: "plan", route: null },
    { published: false, latest: "2026.9.5", decision: "plan", route: null, coreBeta: true },
    { published: false, latest: "2026.9.5", decision: "plan", route: null, bootstrap: true },
    { published: true, latest: version, decision: "already-published", route: "npm-readback" },
    { published: true, latest: "2026.9.7", decision: "superseded", route: "npm-readback" },
  ])("seals registry decision $decision without acknowledging the SDK evidence", async (row) => {
    const input = row.coreBeta ? fixture("beta", "openclaw") : fixture();
    const fetchImpl = vi.fn(async () =>
      row.bootstrap
        ? new Response("{}", { status: 404 })
        : Response.json({
            versions: { "2026.9.5": {}, ...(row.published ? { [version]: {} } : {}) },
            "dist-tags": { latest: row.latest, beta: row.latest },
          }),
    );
    const sealed = await seal({
      ...input,
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sealed).toMatchObject({
      version: 1,
      targetSha,
      npmDistTag: row.coreBeta ? "beta" : "latest",
      pluginSdkApiAcknowledgement: "",
      pluginSdkApiEvidenceDigest: input.digest,
      npmDecisions: [
        {
          packageName: row.coreBeta ? "openclaw" : "@openclaw/example",
          packageVersion: version,
          decision: row.decision,
          route: row.route,
          supersededBy: row.decision === "superseded" ? "2026.9.7" : null,
          bootstrap: row.bootstrap ?? false,
        },
      ],
    });
    if (row.coreBeta) {
      expect(sealed.npmDecisions?.[0]?.plan).toEqual({
        channel: "stable",
        publishTag: "beta",
        mirrorDistTags: [],
      });
    }
    const manifest = { ...input.manifest, publishInputs: sealed };
    expect(resolveReleasePublishInputs(manifest).pluginSdkApiAcknowledgement).toBe("");
    expect(
      resolveReleasePublishInputs(manifest, {
        pluginSdkApiAcknowledgement: " \t ",
      }),
    ).toMatchObject({
      pluginSdkApiAcknowledgement: "",
    });
    expect(
      resolveReleasePublishInputs(manifest, { pluginSdkApiAcknowledgement: " 12345678 " })
        .pluginSdkApiAcknowledgement,
    ).toBe("12345678");
    expect(
      resolveReleasePublishInputs(manifest, {
        pluginSdkApiAcknowledgement: "12345678",
      }),
    ).toMatchObject({
      pluginSdkApiAcknowledgement: "12345678",
    });
    expect(() => resolveReleasePublishInputs(manifest, { targetSha: "d".repeat(40) })).toThrow(
      "target SHA mismatch",
    );
    expect(() =>
      resolveReleasePublishInputs(manifest, { npmDistTag: row.coreBeta ? "latest" : "beta" }),
    ).toThrow("dist-tag mismatch");
    expect(() =>
      resolveReleasePublishInputs({ ...manifest, publishInputs: { ...sealed, npmDecisions: [] } }),
    ).toThrow("roster");
  });

  it.each([
    { mode: "sdk-bytes", error: "digest does not match" },
    { mode: "sdk-head", error: "head SHA does not match" },
    { mode: "npm-source", error: "npm artifact target mismatch" },
    { mode: "empty-history", error: "registry response" },
    { mode: "missing-core", error: "core package missing" },
  ])("rejects $mode before sealing", async ({ mode, error }) => {
    const input = fixture("latest", mode === "missing-core" ? "openclaw" : "@openclaw/example");
    if (mode === "sdk-bytes") {
      input.npmManifest.pluginSdkApi.diff.entrypointsAdded.push("tampered");
    }
    if (mode === "sdk-head") {
      input.npmManifest.pluginSdkApi.headSha = "d".repeat(40);
    }
    if (mode === "npm-source") {
      input.npmManifest.releaseSha = "d".repeat(40);
    }
    const fetchImpl = async () =>
      mode === "missing-core"
        ? new Response("{}", { status: 404 })
        : Response.json({ versions: {}, "dist-tags": {} });
    await expect(seal({ ...input, fetchImpl })).rejects.toThrow(error);
  });

  it.each([
    { manifest: fixture("alpha").manifest, overrides: {}, error: "Alpha releases are retired;" },
    {
      manifest: {},
      overrides: { pluginSdkApiAcknowledgement: "12345678\ninjected=value" },
      error: "SDK override",
    },
    {
      manifest: { publishInputs: { stableSoakWaiver: "approved\nreason" } },
      overrides: {},
      error: "waivers are no longer supported",
    },
  ])(
    "rejects invalid historical publication authority: $error",
    ({ manifest, overrides, error }) => {
      expect(() => resolveReleasePublishInputs(manifest, overrides)).toThrow(error);
    },
  );

  it("leaves historical manifest planning with its existing observer", () => {
    expect(resolveReleasePublishInputs({}, { pluginSdkApiAcknowledgement: " \t " })).toEqual({
      pluginSdkApiAcknowledgement: "",
      npmDecisions: undefined,
    });
    expect(resolveReleasePublishInputs({}, { pluginSdkApiAcknowledgement: "12345678" })).toEqual({
      pluginSdkApiAcknowledgement: "12345678",
      npmDecisions: undefined,
    });
  });
});
