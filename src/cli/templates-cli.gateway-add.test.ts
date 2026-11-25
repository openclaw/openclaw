import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  await cliTestHelpers.mockRegistryPackage(tempDirs, root);
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
