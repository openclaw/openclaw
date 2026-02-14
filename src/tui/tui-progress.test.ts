import { describe, expect, it } from "vitest";
import {
  formatDownloadSpeed,
  formatETA,
  formatModelPullProgress,
  formatProgressBar,
} from "./tui-progress.js";

describe("formatProgressBar", () => {
  it("0%", () => {
    const bar = formatProgressBar(0, 1000, 10);
    expect(bar).toBe("░░░░░░░░░░ 0% • 0B/1000B");
  });

  it("50%", () => {
    const bar = formatProgressBar(500, 1000, 10);
    expect(bar).toBe("█████░░░░░ 50% • 500B/1000B");
  });

  it("100%", () => {
    const bar = formatProgressBar(1000, 1000, 10);
    expect(bar).toBe("██████████ 100% • 1000B/1000B");
  });

  it("large values in GB", () => {
    const bar = formatProgressBar(2.1 * 1024 ** 3, 3.8 * 1024 ** 3, 20);
    expect(bar).toContain("55%");
    expect(bar).toContain("2.1GB");
    expect(bar).toContain("3.8GB");
  });

  it("zero total", () => {
    const bar = formatProgressBar(0, 0, 10);
    expect(bar).toContain("0%");
  });

  it("completed > total clamps to 100%", () => {
    const bar = formatProgressBar(2000, 1000, 10);
    expect(bar).toContain("100%");
    expect(bar).toBe("██████████ 100% • 1000B/1000B");
  });
});

describe("formatDownloadSpeed", () => {
  it("B/s", () => expect(formatDownloadSpeed(500)).toBe("500 B/s"));
  it("KB/s", () => expect(formatDownloadSpeed(1024 * 42.3)).toBe("42.3 KB/s"));
  it("MB/s", () => expect(formatDownloadSpeed(1024 ** 2 * 42.3)).toBe("42.3 MB/s"));
  it("GB/s", () => expect(formatDownloadSpeed(1024 ** 3 * 1.5)).toBe("1.5 GB/s"));
  it("zero", () => expect(formatDownloadSpeed(0)).toBe("0 B/s"));
  it("negative", () => expect(formatDownloadSpeed(-100)).toBe("0 B/s"));
});

describe("formatETA", () => {
  it("seconds only", () => expect(formatETA(500, 100)).toBe("~5s"));
  it("minutes and seconds", () => expect(formatETA(13500, 100)).toBe("~2m 15s"));
  it("exact minutes", () => expect(formatETA(12000, 100)).toBe("~2m"));
  it("zero speed", () => expect(formatETA(1000, 0)).toBe(""));
  it("zero remaining", () => expect(formatETA(0, 100)).toBe(""));
});

describe("formatModelPullProgress", () => {
  it("with progress data", () => {
    const result = formatModelPullProgress("pulling layer", 500, 1000);
    expect(result).toContain("pulling layer");
    expect(result).toContain("50%");
  });

  it("without progress data", () => {
    expect(formatModelPullProgress("verifying sha256")).toBe("verifying sha256");
  });
});
