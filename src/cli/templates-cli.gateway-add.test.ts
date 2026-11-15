import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { create as createTar } from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { templatesAddHandlers } from "../gateway/server-methods/templates-add.js";
import { defaultRuntime } from "../runtime.js";
import { formatCliJsonFailure } from "./failure-output.js";
import { useLocalStateOwnerFixture } from "./local-state-owner.fixture.test-support.js";
import { runTemplatesAddCommand } from "./templates-cli.runtime.js";
import * as cliTestHelpers from "./templates-cli.test-helpers.js";

const packageName = "@acme/demo-agent";

// Keeps the real Gateway plan handler, registry client, downloader, extractor and reader;
// only HTTP responses are controlled.
async function invalidManifestRegistry(tempDirs: { make(prefix: string): string }) {
  const { root } = await cliTestHelpers.writePackageFixture(tempDirs);
  const manifestPath = join(root, "CLAW.md");
  const manifest = JSON.parse((await readFile(manifestPath, "utf8")).split("---")[1]!);
  manifest.skills = [];
  manifest["evil\u202ekey\u009b31m"] = true;
  await writeFile(manifestPath, `---\n${JSON.stringify(manifest)}\n---\n`);
  const archive = join(tempDirs.make("openclaw-registry-archive-"), "package.tgz");
  await createTar({ gzip: true, file: archive, cwd: dirname(root) }, [root.split("/").at(-1)!]);
  const bytes = await readFile(archive);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const npmIntegrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
  const pkg = {
    name: packageName,
    family: "template",
    displayName: "Demo",
    channel: "community",
    isOfficial: false,
    updatedAt: 1,
    latestVersion: "1.2.3",
  };
  const artifact = { kind: "npm-pack", sha256, npmIntegrity };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const route = decodeURIComponent(
      new URL(input instanceof Request ? input.url : String(input)).pathname,
    );
    if (route.endsWith("/artifact/download")) {
      return new Response(bytes, { headers: { "X-ClawHub-Artifact-Sha256": sha256 } });
    }
    if (route.endsWith("/artifact")) {
      return Response.json({ package: pkg, version: "1.2.3", artifact });
    }
    if (route.endsWith("/security")) {
      return Response.json({
        package: pkg,
        release: {
          version: "1.2.3",
          artifactKind: "npm-pack",
          artifactSha256: sha256,
          npmIntegrity,
        },
        overview: "Synthetic security review.",
        securityAuditUrl: "https://clawhub.ai/acme/templates/demo-agent/security-audit",
        verdict: "benign",
        trust: {
          scanStatus: "clean",
          moderationState: "approved",
          blockedFromDownload: false,
          reasons: [],
          pending: false,
          stale: false,
        },
      });
    }
    if (route === "/api/v1/packages/" + packageName) {
      return Response.json({ package: pkg, owner: { handle: "acme" } });
    }
    throw new Error("Unexpected registry request: " + route);
  });
}

describe("Template Add CLI through the Gateway owner", () => {
  const fixture = useLocalStateOwnerFixture();
  afterEach(() => vi.restoreAllMocks());

  beforeEach(async () => {
    const config = {
      ...fixture.config,
      gateway: { ...fixture.config.gateway, controlUi: { experimental: { templates: true } } },
    };
    fixture.config = config;
    await writeFile(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config));
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    fixture.handlers = {
      "templates.catalog.search": async ({ respond }) =>
        respond(true, { entries: [{ packageName, latestVersion: "1.2.3" }] }),
      "templates.add.plan": templatesAddHandlers["templates.add.plan"]!,
    };
  });

  it("strips terminal controls from invalid registry manifest diagnostics", async () => {
    await invalidManifestRegistry(fixture.roots);
    await fixture.startOwner();
    const error = await runTemplatesAddCommand(packageName, {}).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    const printed = (error as Error).message;
    expect(printed).toContain("Downloaded Template package manifest is invalid");
    expect(printed).toContain("evil");
    expect(printed).not.toMatch(/[\u202e\u009b]/u);
    expect(JSON.stringify(formatCliJsonFailure(error))).not.toMatch(/[\u202e\u009b]/u);
  });
});
