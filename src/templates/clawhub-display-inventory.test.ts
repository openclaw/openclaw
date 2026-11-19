import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchClawHubPackageDetail } from "../infra/clawhub-packages.js";
import { readClawHubTemplateDetail as loadDetail } from "./clawhub-source.js";
const baseUrl = "https://registry.example";
const packageName = "@openclaw/research-briefing",
  version = "1.0.0",
  archiveBytes = Buffer.from("inventory fixture"),
  digest = createHash("sha256").update(archiveBytes).digest("hex");
const summary = {
  schemaVersion: 1,
  agent: { id: "research-briefing" },
  workspace: { bootstrapFiles: ["SOUL.md"], fileCount: 1 },
  packages: { skillCount: 1, pluginCount: 0 },
  mcpServerCount: 1,
  cronJobCount: 0,
};
const matchingSecurity = {
  package: { name: packageName, family: "template" },
  release: { version, artifactKind: "npm-pack", artifactSha256: digest, npmIntegrity: "" },
  overview: "Public audit",
  verdict: "benign",
  securityAuditUrl: "https://registry.example/example/security-audit",
  trust: {
    scanStatus: "clean",
    moderationState: "approved",
    blockedFromDownload: false,
    reasons: [],
    pending: false,
    stale: false,
  },
};
const officialPackage = () => ({
  name: packageName,
  displayName: "Research Briefing",
  family: "template",
  channel: "official",
  isOfficial: true,
  ownerHandle: "openclaw",
  updatedAt: 1,
});
const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
beforeEach(() => {
  vi.stubGlobal("fetch", fetch.mockReset());
  vi.stubEnv("CLAWHUB_CONFIG_PATH", "/missing/inventory-test");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const readClawHubTemplateDetail = (args: { packageName: string; version?: string }) =>
  loadDetail({ ...args, baseUrl });
describe("display-only registry inventory", () => {
  const integrity = "sha512-" + createHash("sha512").update(archiveBytes).digest("base64");
  const inventory = () => ({
    schemaVersion: 1,
    packageName,
    version,
    manifestPath: "docs/CLAW.md",
    icon: null,
    artifact: { kind: "npm-pack", sha256: digest, npmIntegrity: integrity },
    templateManifestSummary: { ...summary, packages: { skillCount: 1, pluginCount: 0 } },
    contents: {
      instructions: [
        { name: "SOUL.md", source: "CLAW.md#body" },
        { name: "notes.md", source: "workspace/notes.md" },
      ],
      skills: [{ name: "trip-planner", source: "bundled", path: "skills/trip-planner" }],
      integrations: [{ name: "calendar", kind: "mcpServer" }],
      automations: [],
    },
    security: {
      ...matchingSecurity,
      release: { ...matchingSecurity.release, npmIntegrity: integrity },
    },
  });
  const serve = (
    projection: unknown,
    latestVersion = version,
    claims: Record<string, unknown> = {},
  ) =>
    fetch.mockImplementation(async () =>
      Response.json({
        package: { ...officialPackage(), latestVersion, ...claims },
        owner: { handle: "openclaw", official: true },
        templateInventory: projection,
      }),
    );
  it.each(["artifact", "clawpack"])(
    "rejects a conflicting latest %s digest without fallback",
    async (key) => {
      serve(inventory(), version, { [key]: { sha256: "b".repeat(64) } });
      await expect(readClawHubTemplateDetail({ packageName, version })).rejects.toThrow();
      expectOneRead();
    },
  );
  function expectOneRead() {
    expect(fetch).toHaveBeenCalledOnce();
    const url = new URL(String(fetch.mock.calls[0]![0]));
    expect(url.pathname).toBe("/api/v1/packages/" + encodeURIComponent(packageName));
    expect(url.searchParams.get("view")).toBe("template-inventory");
  }
  it("rejects a too-large inventory response before parsing, without legacy fallback", async () => {
    fetch.mockImplementation(async () => new Response(" ".repeat(512 * 1024 + 1)));
    await expect(
      fetchClawHubPackageDetail({ name: packageName, baseUrl, view: "template-inventory" }),
    ).rejects.toThrow(/exceeded/);
    expectOneRead();
  });
  it.each([false, true])(
    "renders complete inventory from one current read (pin=%s)",
    async (pinned) => {
      const x = inventory();
      serve(
        x,
        pinned ? "9.0.0" : version,
        pinned ? { artifact: { ...x.artifact, sha256: "b".repeat(64) } } : {},
      );
      const detail = await readClawHubTemplateDetail({
        packageName,
        ...(pinned ? { version } : {}),
      });
      expect(detail).toMatchObject({
        version,
        agentId: "research-briefing",
        contents: x.contents,
        workspaceFiles: 2,
        skills: 1,
        mcpServers: 1,
        plugins: 0,
        scheduledJobs: 0,
        security: { verdict: "benign" },
      });
      expectOneRead();
      expect(new URL(String(fetch.mock.calls[0]![0])).searchParams.get("version")).toBe(
        pinned ? version : null,
      );
    },
  );
  it.each([
    ["missing icon", () => ({ ...inventory(), icon: undefined })],
    [
      "conflicting legacy SHA",
      () => ({
        ...inventory(),
        artifact: { ...inventory().artifact, artifactSha256: "f".repeat(64) },
      }),
    ],
    [
      "conflicting legacy kind",
      () => ({ ...inventory(), artifact: { ...inventory().artifact, artifactKind: "legacy-zip" } }),
    ],
    [
      "conflicting source",
      () => ({ ...inventory(), artifact: { ...inventory().artifact, source: "unknown" } }),
    ],
    [
      "conflicting artifact version",
      () => ({ ...inventory(), artifact: { ...inventory().artifact, version: "0.0.0" } }),
    ],
    [
      "unsafe audit link",
      () => ({
        ...inventory(),
        security: { ...inventory().security, securityAuditUrl: "file:///ignored" },
      }),
    ],
    ...["BOOTSTRAP.md", "SOUL.md"].map(
      (name) =>
        [
          "native seed masking missing file: " + name,
          () => ({
            ...inventory(),
            templateManifestSummary: {
              ...inventory().templateManifestSummary,
              workspace: { bootstrapFiles: [], fileCount: 1 },
            },
            contents: {
              ...inventory().contents,
              instructions: [{ name, source: name === "SOUL.md" ? "CLAW.md#body" : name }],
            },
          }),
        ] as const,
    ),
    ["null", () => null],
    ["incomplete", () => ({})],
    ["foreign release", () => ({ ...inventory(), version: "0.9.1" })],
    ["foreign identity", () => ({ ...inventory(), packageName: "other" })],
    [
      "wrong artifact",
      () => ({ ...inventory(), artifact: { ...inventory().artifact, sha256: "b".repeat(64) } }),
    ],
    [
      "wrong integrity",
      () => ({
        ...inventory(),
        artifact: { ...inventory().artifact, npmIntegrity: "sha512-invalid" },
      }),
    ],
    [
      "missing permission",
      () => ({ ...inventory(), security: { ...inventory().security, trust: {} } }),
    ],
    [
      "held",
      () => ({
        ...inventory(),
        security: {
          ...inventory().security,
          trust: { ...matchingSecurity.trust, blockedFromDownload: true },
        },
      }),
    ],
    [
      "quarantined",
      () => ({
        ...inventory(),
        security: {
          ...inventory().security,
          trust: { ...matchingSecurity.trust, moderationState: "quarantined" },
        },
      }),
    ],
    ["missing sections", () => ({ ...inventory(), contents: { instructions: [] } })],
    [
      "missing skill",
      () => ({ ...inventory(), contents: { ...inventory().contents, skills: [] } }),
    ],
    [
      "unexpected excerpt",
      () => ({
        ...inventory(),
        contents: {
          ...inventory().contents,
          instructions: [{ name: "SOUL.md", source: "SOUL.md", excerpt: "unrequested" }],
        },
      }),
    ],
  ] as const)(
    "refuses a present %s inventory, without a secondary read",
    async (_reason, fixture) => {
      serve(fixture());
      await expect(readClawHubTemplateDetail({ packageName, version })).rejects.toThrow();
      expectOneRead();
    },
  );
});
