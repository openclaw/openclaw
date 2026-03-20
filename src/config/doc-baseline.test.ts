import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildConfigDocBaseline,
  collectConfigDocBaselineEntries,
  dedupeConfigDocBaselineEntries,
  normalizeConfigDocBaselineHelpPath,
  renderConfigDocBaselineStatefile,
  writeConfigDocBaselineStatefile,
} from "./doc-baseline.js";

describe("config doc baseline", () => {
  const tempRoots: string[] = [];
  let sharedBaselinePromise: Promise<Awaited<ReturnType<typeof buildConfigDocBaseline>>> | null =
    null;
  let sharedRenderedPromise: Promise<
    Awaited<ReturnType<typeof renderConfigDocBaselineStatefile>>
  > | null = null;

  function getSharedBaseline() {
    sharedBaselinePromise ??= buildConfigDocBaseline();
    return sharedBaselinePromise;
  }

  function getSharedRendered() {
    sharedRenderedPromise ??= renderConfigDocBaselineStatefile(getSharedBaseline());
    return sharedRenderedPromise;
  }

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map(async (tempRoot) => {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }),
    );
  });

  it("is deterministic across repeated runs", async () => {
    const first = await renderConfigDocBaselineStatefile();
    const second = await renderConfigDocBaselineStatefile();

    expect(second.json).toBe(first.json);
    expect(second.jsonl).toBe(first.jsonl);
  });

  it("normalizes array and record paths to wildcard form", async () => {
    const baseline = await getSharedBaseline();
    const paths = new Set(baseline.entries.map((entry) => entry.path));

    expect(paths.has("session.sendPolicy.rules.*.match.keyPrefix")).toBe(true);
    expect(paths.has("env.*")).toBe(true);
    expect(normalizeConfigDocBaselineHelpPath("agents.list[].skills")).toBe("agents.list.*.skills");
  });

  it("includes core, channel, and plugin config metadata", async () => {
    const baseline = await getSharedBaseline();
    const byPath = new Map(baseline.entries.map((entry) => [entry.path, entry]));

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
    const baseline = await getSharedBaseline();
    const byPath = new Map(baseline.entries.map((entry) => [entry.path, entry]));
    const tokenEntry = byPath.get("gateway.auth.token");

    expect(tokenEntry?.help).toContain("gateway access");
    expect(tokenEntry?.tags).toContain("auth");
    expect(tokenEntry?.tags).toContain("security");
  });

  it("matches array help hints that still use [] notation", async () => {
    const baseline = await getSharedBaseline();
    const byPath = new Map(baseline.entries.map((entry) => [entry.path, entry]));

    expect(byPath.get("session.sendPolicy.rules.*.match.keyPrefix")).toMatchObject({
      help: expect.stringContaining("prefer rawKeyPrefix when exact full-key matching is required"),
      sensitive: false,
    });
  });

  it("walks union branches for nested config keys", async () => {
    const baseline = await getSharedBaseline();
    const byPath = new Map(baseline.entries.map((entry) => [entry.path, entry]));

    expect(byPath.get("bindings.*")).toMatchObject({
      hasChildren: true,
    });
    expect(byPath.get("bindings.*.type")).toBeDefined();
    expect(byPath.get("bindings.*.match.channel")).toBeDefined();
    expect(byPath.get("bindings.*.match.peer.id")).toBeDefined();
  });

  it("merges tuple item metadata instead of dropping earlier entries", () => {
    const entries = dedupeConfigDocBaselineEntries(
      collectConfigDocBaselineEntries(
        {
          type: "array",
          items: [
            {
              type: "string",
              enum: ["alpha"],
            },
            {
              type: "number",
              enum: [42],
            },
          ],
        },
        {},
        "tupleValues",
      ),
    );
    const tupleEntry = new Map(entries.map((entry) => [entry.path, entry])).get("tupleValues.*");

    expect(tupleEntry).toMatchObject({
      type: ["number", "string"],
    });
    expect(tupleEntry?.enumValues).toEqual(expect.arrayContaining([42, "alpha"]));
    expect(tupleEntry?.enumValues).toHaveLength(2);
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
