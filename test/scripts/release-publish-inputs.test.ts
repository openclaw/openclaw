import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  createReleasePublishInputs,
  resolveReleasePublishInputs as resolveInputs,
} from "../../scripts/lib/release-publish-inputs.mjs";
import { createPluginSdkApiReleaseEvidence } from "../../scripts/plugin-sdk-api-release-evidence.mjs";

afterEach(() => vi.unstubAllGlobals());

function seal(input: ReturnType<typeof fixture>, fetchImpl: typeof fetch) {
  vi.stubGlobal("fetch", fetchImpl);
  return createReleasePublishInputs(input);
}

const targetSha = "a".repeat(40);
const workflowSha = "b".repeat(40);
const version = "2026.9.6";
const requestUrl = (request: string | URL | Request) =>
  typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
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

it.each([
  { published: false, latest: "2026.9.5", decision: "plan", route: null },
  { published: false, latest: "2026.9.5", decision: "plan", route: null, coreBeta: true },
  { published: false, latest: "2026.9.5", decision: "plan", route: null, bootstrap: true },
  { published: true, latest: version, decision: "already-published", route: "npm-readback" },
  { published: true, latest: "2026.9.7", decision: "superseded", route: "npm-readback" },
])("seals registry decision $decision without acknowledging the SDK evidence", async (row) => {
  const input = row.coreBeta ? fixture("beta", "openclaw") : fixture();
  const fetchImpl = vi.fn(async (request: string | URL | Request) => {
    if (row.bootstrap || requestUrl(request).endsWith(`/${version}`)) {
      return new Response("{}", { status: 404 });
    }
    return Response.json({
      versions: { "2026.9.5": {}, ...(row.published ? { [version]: {} } : {}) },
      "dist-tags": { latest: row.latest, beta: row.latest },
    });
  });
  const sealed = await seal(input, fetchImpl);
  expect(fetchImpl).toHaveBeenCalledTimes(!row.bootstrap && !row.published ? 2 : 1);
  expect(sealed).toMatchObject({
    pluginSdkApiAcknowledgement: "",
    pluginSdkApiEvidenceDigest: input.digest,
    npmDecisions: [
      {
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
  const resolve = (overrides: Parameters<typeof resolveInputs>[1] = {}) =>
    resolveInputs(manifest, overrides);
  const acknowledgement = (value?: string) =>
    resolve({ pluginSdkApiAcknowledgement: value }).pluginSdkApiAcknowledgement;
  expect(resolve().pluginSdkApiAcknowledgement).toBe("");
  expect(acknowledgement(" \t ")).toBe("");
  expect(acknowledgement(" 12345678 ")).toBe("12345678");
  expect(acknowledgement("12345678")).toBe("12345678");
  expect(() => resolve({ targetSha: "d".repeat(40) })).toThrow("target SHA mismatch");
  expect(() => resolve({ npmDistTag: row.coreBeta ? "latest" : "beta" })).toThrow(
    "dist-tag mismatch",
  );
  expect(() =>
    resolveInputs({ ...manifest, publishInputs: { ...sealed, npmDecisions: [] } }),
  ).toThrow("roster");
});

it("seals an exact published decision when abbreviated metadata is stale", async () => {
  const input = fixture();
  const fetchImpl = vi.fn(async (request: string | URL | Request) =>
    requestUrl(request).endsWith(`/${version}`)
      ? Response.json({
          name: "@openclaw/example",
          version,
          dist: { integrity: "sha512-fixture" },
        })
      : Response.json({
          versions: { "2026.9.5": {} },
          "dist-tags": { latest: version, beta: version },
        }),
  );

  const sealed = await seal(input, fetchImpl);

  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(sealed.npmDecisions).toMatchObject([
    {
      packageName: "@openclaw/example",
      packageVersion: version,
      decision: "already-published",
      route: "npm-readback",
      bootstrap: false,
    },
  ]);
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
  const fetchImpl = async (request: string | URL | Request) =>
    mode === "missing-core" ||
    (mode === "empty-history" && requestUrl(request).endsWith(`/${version}`))
      ? new Response("{}", { status: 404 })
      : Response.json({ versions: {}, "dist-tags": {} });
  await expect(seal(input, fetchImpl)).rejects.toThrow(error);
});

it.each([
  [fixture("alpha").manifest, {}, "Alpha releases are retired;"],
  [{}, { pluginSdkApiAcknowledgement: "12345678\ninjected=value" }, "SDK override"],
  [
    { publishInputs: { stableSoakWaiver: "approved\nreason" } },
    {},
    "waivers are no longer supported",
  ],
] as const)(
  "rejects invalid historical publication authority: %j / %j / %s",
  (manifest, overrides, error) => {
    expect(() => resolveInputs(manifest, overrides)).toThrow(error);
  },
);

it.each([
  [" \t ", ""],
  ["12345678", "12345678"],
])("keeps historical planning with acknowledgement %j", (input, expected) => {
  expect(resolveInputs({}, { pluginSdkApiAcknowledgement: input })).toEqual({
    pluginSdkApiAcknowledgement: expected,
    npmDecisions: undefined,
  });
});
