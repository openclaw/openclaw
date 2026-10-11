// Verifies generated config documentation baselines against source metadata.
import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  renderConfigDocBaselineArtifacts,
  writeConfigDocBaselineArtifacts,
} from "./doc-baseline.js";

vi.mock("./doc-baseline.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./doc-baseline.runtime.js")>();
  return {
    ...actual,
    collectBundledChannelConfigs: () => undefined,
  };
});

describe("config doc baseline integration", () => {
  let rendered: Awaited<ReturnType<typeof renderConfigDocBaselineArtifacts>>;

  beforeAll(async () => {
    rendered = await renderConfigDocBaselineArtifacts();
  });

  it("ratchets config entry count budgets in both directions", async () => {
    await withTestDir({ prefix: "openclaw-config-doc-counts-" }, async (tempRoot) => {
      const countsPath = path.join(tempRoot, "docs/.generated/config-baseline.counts.json");

      await writeConfigDocBaselineArtifacts({ repoRoot: tempRoot, rendered });
      const counts = JSON.parse(await fs.readFile(countsPath, "utf8")) as Record<string, number>;
      const coreCount = counts.core;
      if (coreCount === undefined) {
        throw new Error("expected generated config baseline counts to include core");
      }

      await fs.writeFile(
        countsPath,
        `${JSON.stringify({ ...counts, core: coreCount - 1 }, null, 2)}\n`,
        "utf8",
      );
      const growth = await writeConfigDocBaselineArtifacts({
        repoRoot: tempRoot,
        check: true,
        rendered,
      });
      expect(growth.changed).toBe(true);
      expect(growth.countViolations).toHaveLength(1);
      expect(growth.countViolations[0]?.message).toContain(
        `core: current ${coreCount} > budget ${coreCount - 1}; config surface grew`,
      );
      expect(growth.countViolations[0]?.message).toContain("See the AGENTS.md config-surface bar");

      await fs.writeFile(
        countsPath,
        `${JSON.stringify({ ...counts, core: coreCount + 1 }, null, 2)}\n`,
        "utf8",
      );
      const stale = await writeConfigDocBaselineArtifacts({
        repoRoot: tempRoot,
        check: true,
        rendered,
      });
      expect(stale.changed).toBe(true);
      expect(stale.countViolations[0]?.message).toBe(
        `core: current ${coreCount} < budget ${coreCount + 1}; budget is stale; run pnpm config:docs:gen to ratchet it down.`,
      );

      await writeConfigDocBaselineArtifacts({ repoRoot: tempRoot, rendered });
      expect(JSON.parse(await fs.readFile(countsPath, "utf8"))).toEqual(counts);
    });
  });
});
