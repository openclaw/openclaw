import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ConfigDocBaseline,
  type ConfigDocBaselineEntry,
  type ConfigDocBaselineArtifacts,
  flattenConfigDocBaselineEntries,
  renderConfigDocBaselineArtifacts,
  writeConfigDocBaselineArtifacts,
} from "./doc-baseline.js";

describe("config doc baseline integration", () => {
  const tempRoots: string[] = [];
  const generatedBaselinePaths = {
    combined: path.resolve(process.cwd(), "docs/.generated/config-baseline.json"),
    core: path.resolve(process.cwd(), "docs/.generated/config-baseline.core.json"),
    channel: path.resolve(process.cwd(), "docs/.generated/config-baseline.channel.json"),
    plugin: path.resolve(process.cwd(), "docs/.generated/config-baseline.plugin.json"),
  } satisfies Record<keyof ConfigDocBaselineArtifacts, string>;
  let sharedBaselinePromise: Promise<ConfigDocBaseline> | null = null;
  let sharedRenderedPromise: Promise<
    Awaited<ReturnType<typeof renderConfigDocBaselineArtifacts>>
  > | null = null;
  const sharedGeneratedJsonPromises: Partial<
    Record<keyof ConfigDocBaselineArtifacts, Promise<string>>
  > = {};
  let sharedByPathPromise: Promise<Map<string, ConfigDocBaselineEntry>> | null = null;

  function getSharedBaseline() {
    sharedBaselinePromise ??= fs
      .readFile(generatedBaselinePaths.combined, "utf8")
      .then((raw) => JSON.parse(raw) as ConfigDocBaseline);
    return sharedBaselinePromise;
  }

  function getSharedRendered() {
    sharedRenderedPromise ??= renderConfigDocBaselineArtifacts(getSharedBaseline());
    return sharedRenderedPromise;
  }

  function getGeneratedJson(kind: keyof ConfigDocBaselineArtifacts) {
    sharedGeneratedJsonPromises[kind] ??= fs.readFile(generatedBaselinePaths[kind], "utf8");
    return sharedGeneratedJsonPromises[kind];
  }

  function getSharedByPath() {
    sharedByPathPromise ??= getSharedBaseline().then(
      (baseline) =>
        new Map(flattenConfigDocBaselineEntries(baseline).map((entry) => [entry.path, entry])),
    );
    return sharedByPathPromise;
  }

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map(async (tempRoot) => {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }),
    );
  });

  it("is deterministic across repeated runs", async () => {
    const baseline = await getSharedBaseline();
    const first = await renderConfigDocBaselineArtifacts(baseline);
    const second = await renderConfigDocBaselineArtifacts(baseline);

    expect(second.json.combined).toBe(first.json.combined);
    expect(second.json.core).toBe(first.json.core);
    expect(second.json.channel).toBe(first.json.channel);
    expect(second.json.plugin).toBe(first.json.plugin);
  });

  it("matches the checked-in generated baseline artifacts", async () => {
    const [rendered, generatedCombined, generatedCore, generatedChannel, generatedPlugin] =
      await Promise.all([
        getSharedRendered(),
        getGeneratedJson("combined"),
        getGeneratedJson("core"),
        getGeneratedJson("channel"),
        getGeneratedJson("plugin"),
      ]);

    expect(rendered.json.combined).toBe(generatedCombined);
    expect(rendered.json.core).toBe(generatedCore);
    expect(rendered.json.channel).toBe(generatedChannel);
    expect(rendered.json.plugin).toBe(generatedPlugin);
  });

  it("includes core, channel, and plugin config metadata", async () => {
    const byPath = await getSharedByPath();

    expect(byPath.get("gateway.auth.token")).toMatchObject({
      kind: "core",
      sensitive: true,
    });
    expect(byPath.get("channels.telegram.botToken")).toMatchObject({
      kind: "channel",
      sensitive: true,
    });
    expect(byPath.get("plugins.entries.voice-call.config.twilio.authToken")).toMatchObject({
      kind: "plugin",
      sensitive: true,
    });
  });

  it("preserves help text and tags from merged schema hints", async () => {
    const byPath = await getSharedByPath();
    const tokenEntry = byPath.get("gateway.auth.token");

    expect(tokenEntry?.help).toContain("gateway access");
    expect(tokenEntry?.tags).toContain("auth");
    expect(tokenEntry?.tags).toContain("security");
  });

  it("uses human-readable channel metadata for top-level channel sections", async () => {
    const byPath = await getSharedByPath();

    expect(byPath.get("channels.discord")).toMatchObject({
      label: "Discord",
      help: "very well supported right now.",
    });
    expect(byPath.get("channels.msteams")).toMatchObject({
      label: "Microsoft Teams",
      help: "Teams SDK; enterprise support.",
    });
    expect(byPath.get("channels.matrix")).toMatchObject({
      label: "Matrix",
      help: "open protocol; install the plugin to enable.",
    });
    expect(byPath.get("channels.msteams")?.label).not.toContain("@openclaw/");
    expect(byPath.get("channels.matrix")?.help).not.toContain("homeserver");
  });

  it("matches array help hints that still use [] notation", async () => {
    const byPath = await getSharedByPath();

    expect(byPath.get("session.sendPolicy.rules.*.match.keyPrefix")).toMatchObject({
      help: expect.stringContaining("prefer rawKeyPrefix when exact full-key matching is required"),
      sensitive: false,
    });
  });

  it("walks union branches for nested config keys", async () => {
    const byPath = await getSharedByPath();

    expect(byPath.get("bindings.*")).toMatchObject({
      hasChildren: true,
    });
    expect(byPath.get("bindings.*.type")).toBeDefined();
    expect(byPath.get("bindings.*.match.channel")).toBeDefined();
    expect(byPath.get("bindings.*.match.peer.id")).toBeDefined();
  });

  it("supports check mode for stale generated artifacts", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-doc-baseline-"));
    tempRoots.push(tempRoot);
    const rendered = getSharedRendered();

    const initial = await writeConfigDocBaselineArtifacts({
      repoRoot: tempRoot,
      combinedPath: "docs/.generated/config-baseline.json",
      corePath: "docs/.generated/config-baseline.core.json",
      channelPath: "docs/.generated/config-baseline.channel.json",
      pluginPath: "docs/.generated/config-baseline.plugin.json",
      rendered,
    });
    expect(initial.wrote).toBe(true);

    const current = await writeConfigDocBaselineArtifacts({
      repoRoot: tempRoot,
      combinedPath: "docs/.generated/config-baseline.json",
      corePath: "docs/.generated/config-baseline.core.json",
      channelPath: "docs/.generated/config-baseline.channel.json",
      pluginPath: "docs/.generated/config-baseline.plugin.json",
      check: true,
      rendered,
    });
    expect(current.changed).toBe(false);

    await fs.writeFile(
      path.join(tempRoot, "docs/.generated/config-baseline.json"),
      '{"generatedBy":"broken","entries":[]}\n',
      "utf8",
    );

    const stale = await writeConfigDocBaselineArtifacts({
      repoRoot: tempRoot,
      combinedPath: "docs/.generated/config-baseline.json",
      corePath: "docs/.generated/config-baseline.core.json",
      channelPath: "docs/.generated/config-baseline.channel.json",
      pluginPath: "docs/.generated/config-baseline.plugin.json",
      check: true,
      rendered,
    });
    expect(stale.changed).toBe(true);
    expect(stale.wrote).toBe(false);
  });
});
