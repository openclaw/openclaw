import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const note = vi.hoisted(() => vi.fn());
const mockGetSecurityHealthReport = vi.hoisted(() => vi.fn());
const mockFormatHealthSummary = vi.hoisted(() => vi.fn(() => "GOOD: Security posture healthy"));
const mockResolveCredentialVaultDir = vi.hoisted(() => vi.fn<() => string>());

vi.mock("../terminal/note.js", () => ({ note }));
vi.mock("../channels/plugins/index.js", () => ({ listChannelPlugins: () => [] }));
vi.mock("../security/security-health.js", () => ({
  getSecurityHealthReport: mockGetSecurityHealthReport,
  formatHealthSummary: mockFormatHealthSummary,
}));
vi.mock("../security/credential-vault.js", () => ({
  resolveCredentialVaultDir: mockResolveCredentialVaultDir,
}));

// Import after mocks are established.
import { noteSecurityPosture } from "./doctor-security.js";

// ── Minimal health report shape ────────────────────────────────────────────

const HEALTHY_REPORT = {
  vault: { auditIntegrityOk: true, rotationDueCount: 0 },
  monitoring: {
    criticalEvents: 0,
    recentCriticalAlerts: [] as string[],
    highRiskSessions: 0,
    runnerRunning: true,
  },
  injectionDefense: { criticalDetections: 0 },
};

// ── Helpers ────────────────────────────────────────────────────────────────

function lastNoteText(): string {
  return String(note.mock.calls.at(-1)?.[0] ?? "");
}

describe("noteSecurityPosture — legacy credentials.json detection (CD-4)", () => {
  let tmpVaultDir: string;

  beforeEach(() => {
    note.mockClear();
    mockGetSecurityHealthReport.mockResolvedValue(HEALTHY_REPORT);
    mockFormatHealthSummary.mockReturnValue("GOOD: Security posture healthy");

    // Fresh temp dir per test — no pre-existing files.
    tmpVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-vault-test-"));
    mockResolveCredentialVaultDir.mockReturnValue(tmpVaultDir);
  });

  afterEach(() => {
    fs.rmSync(tmpVaultDir, { recursive: true, force: true });
  });

  it("does NOT warn when credentials.json is absent", async () => {
    await noteSecurityPosture();

    const text = lastNoteText();
    expect(text).not.toContain("Legacy plaintext credential file");
    expect(text).not.toContain("credentials.json");
  });

  it("warns when legacy credentials.json exists alongside the vault", async () => {
    const legacyPath = path.join(tmpVaultDir, "credentials.json");
    fs.writeFileSync(legacyPath, JSON.stringify({ someKey: "some-value" }));

    await noteSecurityPosture();

    const text = lastNoteText();
    expect(text).toContain("Legacy plaintext credential file");
    expect(text).toContain("credentials.json");
    expect(text).toContain("openclaw security credentials migrate");
  });

  it("includes the full path to the legacy file in the warning", async () => {
    const legacyPath = path.join(tmpVaultDir, "credentials.json");
    fs.writeFileSync(legacyPath, "{}");

    await noteSecurityPosture();

    expect(lastNoteText()).toContain(legacyPath);
  });

  it("still shows posture summary alongside the legacy-file warning", async () => {
    const legacyPath = path.join(tmpVaultDir, "credentials.json");
    fs.writeFileSync(legacyPath, "{}");

    await noteSecurityPosture();

    const text = lastNoteText();
    expect(text).toContain("GOOD: Security posture healthy");
    expect(text).toContain("Legacy plaintext credential file");
  });

  it("does not warn when only credentials.enc is present (encrypted vault)", async () => {
    fs.writeFileSync(path.join(tmpVaultDir, "credentials.enc"), Buffer.from("OCVAULT..."));

    await noteSecurityPosture();

    expect(lastNoteText()).not.toContain("Legacy plaintext credential file");
  });

  it("falls back gracefully when getSecurityHealthReport throws", async () => {
    mockGetSecurityHealthReport.mockRejectedValue(new Error("runner offline"));

    // Should NOT throw — catches internally and emits the fallback note.
    await expect(noteSecurityPosture()).resolves.toBeUndefined();
    expect(note).toHaveBeenCalled();
    expect(lastNoteText()).toContain("unavailable");
  });
});
