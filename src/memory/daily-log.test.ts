import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDailyLogFile,
  DEFAULT_DAILY_LOG_TEMPLATE,
  ensureDailyLogFiles,
  formatDate,
  getDailyLogPath,
  renderDailyLogTemplate,
} from "./daily-log.js";

const tempDirs = new Set<string>();

async function makeTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-log-"));
  tempDirs.add(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(Array.from(tempDirs, (dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe("daily log helpers", () => {
  it("formats dates as YYYY-MM-DD", () => {
    expect(formatDate(new Date("2026-02-27T14:00:00Z"))).toBe("2026-02-27");
  });

  it("renders every date placeholder in the template", () => {
    const rendered = renderDailyLogTemplate("{{date}}\n{{date}}", new Date("2026-02-27T14:00:00Z"));
    expect(rendered).toBe("2026-02-27\n2026-02-27");
  });

  it("builds daily log paths inside the workspace memory directory", () => {
    expect(getDailyLogPath("/tmp/workspace", new Date("2026-02-27T14:00:00Z"))).toBe(
      path.join("/tmp/workspace", "memory", "2026-02-27.md"),
    );
  });

  it("creates a daily log file once and keeps the existing file on rerun", async () => {
    const workspaceDir = await makeTempWorkspace();
    const date = new Date("2026-02-27T14:00:00Z");

    const first = await createDailyLogFile({
      workspaceDir,
      date,
      template: DEFAULT_DAILY_LOG_TEMPLATE,
    });
    expect(first.created).toBe(true);

    await fs.writeFile(first.path, "# preserved\n", "utf-8");

    const second = await createDailyLogFile({
      workspaceDir,
      date,
      template: "should not overwrite",
    });
    expect(second.created).toBe(false);
    await expect(fs.readFile(first.path, "utf-8")).resolves.toBe("# preserved\n");
  });

  it("creates today and future files up to createDaysAhead", async () => {
    const workspaceDir = await makeTempWorkspace();
    const result = await ensureDailyLogFiles({
      workspaceDir,
      createDaysAhead: 2,
      baseDate: new Date("2026-02-27T14:00:00Z"),
    });

    expect(result.created).toBe(3);
    expect(result.paths.map((filePath) => path.basename(filePath))).toEqual([
      "2026-02-27.md",
      "2026-02-28.md",
      "2026-03-01.md",
    ]);
  });

  it("preserves existing content while still creating missing future files", async () => {
    const workspaceDir = await makeTempWorkspace();
    const existingPath = getDailyLogPath(workspaceDir, new Date("2026-02-27T14:00:00Z"));
    await fs.mkdir(path.dirname(existingPath), { recursive: true });
    await fs.writeFile(existingPath, "# existing\n", "utf-8");

    const result = await ensureDailyLogFiles({
      workspaceDir,
      createDaysAhead: 1,
      baseDate: new Date("2026-02-27T14:00:00Z"),
    });

    expect(result.created).toBe(1);
    await expect(fs.readFile(existingPath, "utf-8")).resolves.toBe("# existing\n");
    await expect(
      fs.readFile(getDailyLogPath(workspaceDir, new Date("2026-02-28T14:00:00Z")), "utf-8"),
    ).resolves.toContain("2026-02-28");
  });
});
