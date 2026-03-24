import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ClawHubSkillDetail } from "../infra/clawhub.js";

const { hiveTestRoot } = vi.hoisted(() => {
  const path = require("node:path") as typeof import("node:path");
  const os = require("node:os") as typeof import("node:os");
  const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
  return {
    hiveTestRoot: path.join(os.tmpdir(), `hive-sync-${randomBytes(8).toString("hex")}`),
  };
});

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return { ...actual, CONFIG_DIR: hiveTestRoot };
});

import { syncHiveSkillFeed } from "./skill-feed-sync.js";

beforeEach(async () => {
  await fs.rm(hiveTestRoot, { recursive: true, force: true }).catch(() => undefined);
  await fs.mkdir(path.join(hiveTestRoot, "skills"), { recursive: true });
});

afterAll(async () => {
  await fs.rm(hiveTestRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe("syncHiveSkillFeed", () => {
  it("no-ops when hive is disabled", async () => {
    const res = await syncHiveSkillFeed({
      cfg: {} as OpenClawConfig,
      manifest: { version: 1, entries: [{ slug: "x" }] },
    });
    expect(res.skipped).toBe(true);
    expect(res.results).toHaveLength(0);
  });

  it("installs and updates lockfile with mocked ClawHub", async () => {
    const detail: ClawHubSkillDetail = {
      skill: {
        slug: "demo",
        displayName: "Demo",
        createdAt: 1,
        updatedAt: 2,
      },
      latestVersion: { version: "1.0.0", createdAt: 1 },
      owner: { handle: "owner1" },
    };

    const res = await syncHiveSkillFeed({
      cfg: { skills: { hive: { enabled: true } } } as OpenClawConfig,
      manifest: { version: 1, entries: [{ slug: "demo", version: "1.0.0" }] },
      deps: {
        fetchClawHubSkillDetail: vi.fn(async () => detail),
        installSkillFromClawHub: vi.fn(async () => {
          const skillDir = path.join(hiveTestRoot, "skills", "demo");
          await fs.mkdir(skillDir, { recursive: true });
          await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Demo\n", "utf-8");
          await fs.writeFile(path.join(skillDir, "noop.ts"), "// ok\n", "utf-8");
          return {
            ok: true as const,
            slug: "demo",
            version: "1.0.0",
            targetDir: skillDir,
            detail,
          };
        }),
      },
    });

    expect(res.ok).toBe(true);
    expect(res.results.some((r) => r.slug === "demo" && r.ok)).toBe(true);
  });
});
