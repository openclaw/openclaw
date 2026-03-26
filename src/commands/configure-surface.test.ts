import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureSurfaceCommand } from "./configure-surface.js";

const readBestEffortConfig = vi.fn();
vi.mock("../config/config.js", () => ({
  readBestEffortConfig: () => readBestEffortConfig(),
}));

const exportSetupSurface = vi.fn();
vi.mock("../setup/surface-export.js", () => ({
  exportSetupSurface: (...args: unknown[]) => exportSetupSurface(...args),
}));

describe("configureSurfaceCommand", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("writes exported setup surface JSON and prints the output path", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-surface-"));
    const outputPath = path.join(outputDir, "surface.json");
    const runtime = {
      writeStdout: vi.fn(),
    };

    readBestEffortConfig.mockResolvedValue({});
    exportSetupSurface.mockResolvedValue({
      version: 1,
      generatedAt: "2026-03-26T00:00:00.000Z",
      sections: ["providers", "channels"],
      providers: [],
      channels: [],
    });

    await configureSurfaceCommand({
      jsonOut: outputPath,
      section: ["providers", "channels"],
      runtime: runtime as never,
    });

    const raw = await fs.readFile(outputPath, "utf8");
    expect(JSON.parse(raw)).toMatchObject({
      version: 1,
      sections: ["providers", "channels"],
    });
    expect(exportSetupSurface).toHaveBeenCalledWith({
      config: {},
      sections: ["providers", "channels"],
    });
    expect(runtime.writeStdout).toHaveBeenCalledWith(outputPath);
  });
});
