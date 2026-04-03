import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ConfigDocBaseline,
  type ConfigDocBaselineEntry,
  flattenConfigDocBaselineEntries,
  renderConfigDocBaselineStatefile,
  writeConfigDocBaselineStatefile,
} from "./doc-baseline.js";

describe("config doc baseline integration", () => {
  const tempRoots: string[] = [];
  const generatedBaselineJsonPath = path.resolve(
    process.cwd(),
    "docs/.generated/config-baseline.json",
  );
  const generatedBaselineJsonlPath = path.resolve(
    process.cwd(),
    "docs/.generated/config-baseline.jsonl",
  );
  let sharedBaselinePromise: Promise<ConfigDocBaseline> | null = null;
  let sharedRenderedPromise: Promise<
    Awaited<ReturnType<typeof renderConfigDocBaselineStatefile>>
  > | null = null;
  let sharedGeneratedJsonPromise: Promise<string> | null = null;
  let sharedGeneratedJsonlPromise: Promise<string> | null = null;
  let sharedByPathPromise: Promise<Map<string, ConfigDocBaselineEntry>> | null = null;

  function getSharedBaseline() {
    sharedBaselinePromise ??= fs
      .readFile(generatedBaselineJsonPath, "utf8")
      .then((raw) => JSON.parse(raw) as ConfigDocBaseline);
    return sharedBaselinePromise;
  }

  function getSharedRendered() {
    sharedRenderedPromise ??= renderConfigDocBaselineStatefile(getSharedBaseline());
    return sharedRenderedPromise;
  }

  function getGeneratedJson() {
    sharedGeneratedJsonPromise ??= fs.readFile(generatedBaselineJsonPath, "utf8");
    return sharedGeneratedJsonPromise;
  }

  function getGeneratedJsonl() {
    sharedGeneratedJsonlPromise ??= fs.readFile(generatedBaselineJsonlPath, "utf8");
    return sharedGeneratedJsonlPromise;
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
    const first = await renderConfigDocBaselineStatefile(baseline);
    const second = await renderConfigDocBaselineStatefile(baseline);

    expect(second.json).toBe(first.json);
    expect(second.jsonl).toBe(first.jsonl);
  });

  it("matches the checked-in generated baseline artifacts", async () => {
    const [rendered, generatedJson, generatedJsonl] = await Promise.all([
      getSharedRendered(),
      getGeneratedJson(),
      getGeneratedJsonl(),
    ]);

    expect(rendered.json).toBe(generatedJson);
    expect(rendered.jsonl).toBe(generatedJsonl);
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

    const initial = await writeConfigDocBaselineStatefile({
      repoRoot: tempRoot,
      jsonPath: "docs/.generated/config-baseline.json",
      statefilePath: "docs/.generated/config-baseline.jsonl",
      rendered,
    });
    expect(initial.wrote).toBe(true);

    const current = await writeConfigDocBaselineStatefile({
      repoRoot: tempRoot,
      jsonPath: "docs/.generated/config-baseline.json",
      statefilePath: "docs/.generated/config-baseline.jsonl",
      check: true,
      rendered,
    });
    expect(current.changed).toBe(false);

    await fs.writeFile(
      path.join(tempRoot, "docs/.generated/config-baseline.json"),
      '{"generatedBy":"broken","entries":[]}\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(tempRoot, "docs/.generated/config-baseline.jsonl"),
      '{"recordType":"meta","generatedBy":"broken","totalPaths":0}\n',
      "utf8",
    );

    const stale = await writeConfigDocBaselineStatefile({
      repoRoot: tempRoot,
      jsonPath: "docs/.generated/config-baseline.json",
      statefilePath: "docs/.generated/config-baseline.jsonl",
      check: true,
      rendered,
    });
    expect(stale.changed).toBe(true);
    expect(stale.wrote).toBe(false);
  });
});
