/**
 * Unit tests for WSL environment diagnostics (doctor-wsl.ts).
 *
 * Covers:
 *   - INI parser (parseINI)
 *   - Memory string parser (parseMemoryToMB)
 *   - Diagnostic note builder (buildWSLDiagnosticNotes)
 *   - Environment summary builder (buildWSLInfoSummary)
 */

import { describe, expect, it } from "vitest";
import {
  buildWSLDiagnosticNotes,
  buildWSLInfoSummary,
  parseINI,
  parseMemoryToMB,
  type WSLDiagnostics,
} from "./doctor-wsl.js";

// ─── parseINI ───────────────────────────────────────────────────

describe("parseINI", () => {
  it("parses a standard wsl.conf file", () => {
    const content = ["[boot]", "systemd=true", "", "[automount]", "enabled = true"].join("\n");
    const result = parseINI(content);
    expect(result["boot"]).toEqual({ systemd: "true" });
    expect(result["automount"]).toEqual({ enabled: "true" });
  });

  it("parses a .wslconfig file with [wsl2] section", () => {
    const content = ["[wsl2]", "memory=8GB", "processors=4", "swap=4GB"].join("\n");
    const result = parseINI(content);
    expect(result["wsl2"]).toEqual({ memory: "8GB", processors: "4", swap: "4GB" });
  });

  it("skips comments and blank lines", () => {
    const content = ["# comment", "; also a comment", "", "[boot]", "systemd=true"].join("\n");
    const result = parseINI(content);
    expect(result["boot"]).toEqual({ systemd: "true" });
  });

  it("handles Windows CRLF line endings", () => {
    const content = "[wsl2]\r\nmemory=4GB\r\nprocessors=2\r\n";
    const result = parseINI(content);
    expect(result["wsl2"]).toEqual({ memory: "4GB", processors: "2" });
  });

  it("returns empty object for empty input", () => {
    expect(parseINI("")).toEqual({});
  });

  it("normalizes section names to lowercase", () => {
    const result = parseINI("[WSL2]\nmemory=8GB");
    expect(result["wsl2"]).toEqual({ memory: "8GB" });
  });

  it("normalizes keys to lowercase", () => {
    const result = parseINI("[boot]\nSystemd=true");
    expect(result["boot"]).toEqual({ systemd: "true" });
  });
});

// ─── parseMemoryToMB ────────────────────────────────────────────

describe("parseMemoryToMB", () => {
  it("parses GB values", () => {
    expect(parseMemoryToMB("8GB")).toBe(8192);
    expect(parseMemoryToMB("4gb")).toBe(4096);
    expect(parseMemoryToMB("8g")).toBe(8192);
    expect(parseMemoryToMB("0.5GB")).toBe(512);
  });

  it("parses MB values", () => {
    expect(parseMemoryToMB("4096MB")).toBe(4096);
    expect(parseMemoryToMB("512m")).toBe(512);
  });

  it("parses TB values", () => {
    expect(parseMemoryToMB("1TB")).toBe(1048576);
    expect(parseMemoryToMB("1t")).toBe(1048576);
  });

  it("treats bare numbers as MB", () => {
    expect(parseMemoryToMB("4096")).toBe(4096);
  });

  it("returns null for null or empty string", () => {
    expect(parseMemoryToMB(null)).toBeNull();
    expect(parseMemoryToMB("")).toBeNull();
  });

  it("returns null for unparseable values", () => {
    expect(parseMemoryToMB("abc")).toBeNull();
    expect(parseMemoryToMB("GB")).toBeNull();
  });

  it("trims whitespace", () => {
    expect(parseMemoryToMB("  8GB  ")).toBe(8192);
  });
});

// ─── buildWSLDiagnosticNotes ────────────────────────────────────

describe("buildWSLDiagnosticNotes", () => {
  function healthyDiag(): WSLDiagnostics {
    return {
      isWSL: true,
      isWSL2: true,
      systemdAvailable: true,
      wslConfSystemdEnabled: true,
      wslconfig: { memory: "8GB", processors: 4, swap: "4GB" },
      kernelVersion: "5.15.153.1-microsoft-standard-WSL2",
      wslVisibleMemoryBytes: 32 * 1024 * 1024 * 1024,
    };
  }

  it("returns empty array when everything is healthy", () => {
    expect(buildWSLDiagnosticNotes(healthyDiag())).toEqual([]);
  });

  it("does not emit systemd notes (handled by gateway daemon flow)", () => {
    const diag = healthyDiag();
    diag.systemdAvailable = false;
    diag.wslConfSystemdEnabled = false;
    const notes = buildWSLDiagnosticNotes(diag);
    expect(notes.every((n) => !n.includes("systemd"))).toBe(true);
  });

  it("warns when WSL memory limit is below 4GB", () => {
    const diag = healthyDiag();
    diag.wslconfig = { memory: "2GB", processors: 4, swap: "1GB" };
    const notes = buildWSLDiagnosticNotes(diag);
    expect(notes.some((n) => n.includes("too low"))).toBe(true);
    expect(notes.some((n) => n.includes("at least 4GB"))).toBe(true);
  });

  it("warns when processor count is below 2", () => {
    const diag = healthyDiag();
    diag.wslconfig = { memory: "8GB", processors: 1, swap: "4GB" };
    const notes = buildWSLDiagnosticNotes(diag);
    expect(notes.some((n) => n.includes("processor limit is 1"))).toBe(true);
    expect(notes.some((n) => n.includes("2+ cores"))).toBe(true);
  });

  it("does not warn when memory and processors are sufficient", () => {
    const diag = healthyDiag();
    diag.wslconfig = { memory: "16GB", processors: 8, swap: "8GB" };
    expect(buildWSLDiagnosticNotes(diag)).toEqual([]);
  });

  it("warns when no .wslconfig and WSL visible memory is below 4GB", () => {
    const diag = healthyDiag();
    diag.wslconfig = null;
    // os.totalmem() inside WSL returns the WSL VM allocation directly
    diag.wslVisibleMemoryBytes = 3 * 1024 * 1024 * 1024; // 3GB visible
    const notes = buildWSLDiagnosticNotes(diag);
    expect(notes.some((n) => n.includes("limited to ~3GB"))).toBe(true);
    expect(notes.some((n) => n.includes(".wslconfig"))).toBe(true);
  });

  it("does not warn when no .wslconfig but WSL visible memory is ample", () => {
    const diag = healthyDiag();
    diag.wslconfig = null;
    // 8GB visible — well above the 4GB threshold
    diag.wslVisibleMemoryBytes = 8 * 1024 * 1024 * 1024;
    expect(buildWSLDiagnosticNotes(diag)).toEqual([]);
  });

  it("returns empty array for non-WSL environments", () => {
    const diag: WSLDiagnostics = {
      isWSL: false,
      isWSL2: false,
      systemdAvailable: false,
      wslConfSystemdEnabled: null,
      wslconfig: null,
      kernelVersion: null,
      wslVisibleMemoryBytes: 32 * 1024 * 1024 * 1024,
    };
    expect(buildWSLDiagnosticNotes(diag)).toEqual([]);
  });
});

// ─── buildWSLInfoSummary ────────────────────────────────────────

describe("buildWSLInfoSummary", () => {
  it("produces a full summary for a healthy WSL2 environment", () => {
    const summary = buildWSLInfoSummary({
      isWSL: true,
      isWSL2: true,
      systemdAvailable: true,
      wslConfSystemdEnabled: true,
      wslconfig: { memory: "8GB", processors: 4, swap: "4GB" },
      kernelVersion: "5.15.153.1-microsoft-standard-WSL2",
      wslVisibleMemoryBytes: 32 * 1024 * 1024 * 1024,
    });
    expect(summary).toContain("WSL2");
    expect(summary).toContain("systemd ✓");
    expect(summary).toContain("memory limit 8GB");
    expect(summary).toContain("4 processors");
    expect(summary).toContain("kernel");
  });

  it("shows systemd ✗ in summary when unavailable", () => {
    const summary = buildWSLInfoSummary({
      isWSL: true,
      isWSL2: true,
      systemdAvailable: false,
      wslConfSystemdEnabled: false,
      wslconfig: { memory: "8GB", processors: 4, swap: "4GB" },
      kernelVersion: "5.15.153.1-microsoft-standard-WSL2",
      wslVisibleMemoryBytes: 32 * 1024 * 1024 * 1024,
    });
    expect(summary).toContain("systemd ✗");
  });

  it("identifies WSL1 correctly", () => {
    const summary = buildWSLInfoSummary({
      isWSL: true,
      isWSL2: false,
      systemdAvailable: false,
      wslConfSystemdEnabled: false,
      wslconfig: null,
      kernelVersion: null,
      wslVisibleMemoryBytes: 16 * 1024 * 1024 * 1024,
    });
    expect(summary).toContain("WSL1");
    expect(summary).toContain("systemd ✗");
  });

  it("returns null for non-WSL environments", () => {
    const summary = buildWSLInfoSummary({
      isWSL: false,
      isWSL2: false,
      systemdAvailable: false,
      wslConfSystemdEnabled: null,
      wslconfig: null,
      kernelVersion: null,
      wslVisibleMemoryBytes: 32 * 1024 * 1024 * 1024,
    });
    expect(summary).toBeNull();
  });

  it("omits resource info when .wslconfig is absent", () => {
    const summary = buildWSLInfoSummary({
      isWSL: true,
      isWSL2: true,
      systemdAvailable: true,
      wslConfSystemdEnabled: true,
      wslconfig: null,
      kernelVersion: "5.15.153.1-microsoft-standard-WSL2",
      wslVisibleMemoryBytes: 32 * 1024 * 1024 * 1024,
    });
    expect(summary).toContain("WSL2");
    expect(summary).not.toContain("memory limit");
    expect(summary).not.toContain("processors");
  });
});
