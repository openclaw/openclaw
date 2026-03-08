import path from "node:path";
import { describe, expect, it } from "vitest";
import { listSreStateDirs, resolveSreStatePaths } from "./paths.js";

describe("resolveSreStatePaths", () => {
  it("derives default directories from OPENCLAW_STATE_DIR", () => {
    const paths = resolveSreStatePaths({
      OPENCLAW_STATE_DIR: "/tmp/openclaw",
    });

    expect(paths).toEqual({
      stateRootDir: "/tmp/openclaw/state",
      graphDir: "/tmp/openclaw/state/sre-graph",
      dossiersDir: "/tmp/openclaw/state/sre-dossiers",
      indexDir: "/tmp/openclaw/state/sre-index",
      plansDir: "/tmp/openclaw/state/sre-plans",
    });
  });

  it("honors explicit per-directory overrides", () => {
    const paths = resolveSreStatePaths({
      OPENCLAW_STATE_DIR: "/tmp/openclaw",
      OPENCLAW_SRE_GRAPH_DIR: "/var/lib/sre/graph",
      OPENCLAW_SRE_PLANS_DIR: "/var/lib/sre/plans",
    });

    expect(paths.graphDir).toBe("/var/lib/sre/graph");
    expect(paths.plansDir).toBe("/var/lib/sre/plans");
    expect(paths.indexDir).toBe("/tmp/openclaw/state/sre-index");
  });

  it("keeps SRE directories distinct from sentinel incident state", () => {
    const paths = resolveSreStatePaths({
      OPENCLAW_STATE_DIR: "/tmp/openclaw",
    });
    const sentinelDir = path.join("/tmp/openclaw", "state", "sentinel");

    expect(listSreStateDirs(paths)).not.toContain(sentinelDir);
    expect(new Set(listSreStateDirs(paths)).size).toBe(4);
  });
});
