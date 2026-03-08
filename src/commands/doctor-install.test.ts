import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn().mockReturnValue(false),
  realpathSync: vi.fn((p: string) => p),
  readFileSync: vi.fn().mockReturnValue("{}"),
  readdirSync: vi.fn().mockReturnValue([]),
  execSync: vi.fn().mockReturnValue(""),
  note: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return {
    ...actual,
    default: {
      ...(actual.default as Record<string, unknown>),
      existsSync: mocks.existsSync,
      realpathSync: mocks.realpathSync,
      readFileSync: mocks.readFileSync,
      readdirSync: mocks.readdirSync,
    },
    existsSync: mocks.existsSync,
    realpathSync: mocks.realpathSync,
    readFileSync: mocks.readFileSync,
    readdirSync: mocks.readdirSync,
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return {
    ...actual,
    execSync: mocks.execSync,
  };
});

vi.mock("../terminal/note.js", () => ({
  note: mocks.note,
}));

import { detectDuplicateInstallations } from "./doctor-install.js";

describe("detectDuplicateInstallations", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSync.mockReturnValue(false);
    mocks.realpathSync.mockImplementation((p: string) => p);
    mocks.readFileSync.mockReturnValue("{}");
    mocks.readdirSync.mockReturnValue([]);
    mocks.execSync.mockReturnValue("");
    process.env = { ...savedEnv, HOME: "/home/testuser" };
  });

  it("emits nothing when no installations are found", () => {
    detectDuplicateInstallations();
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("emits nothing when only one installation exists", () => {
    mocks.existsSync.mockImplementation((p: string) => p === "/usr/bin/openclaw");
    mocks.realpathSync.mockReturnValue("/usr/bin/openclaw");

    detectDuplicateInstallations();

    expect(mocks.note).not.toHaveBeenCalledWith(
      expect.stringContaining("Duplicate"),
      expect.anything(),
    );
  });

  it("emits nothing when two paths resolve to the same realpath", () => {
    mocks.existsSync.mockImplementation(
      (p: string) => p === "/usr/bin/openclaw" || p === "/usr/local/bin/openclaw",
    );
    // Both symlink to same physical file
    mocks.realpathSync.mockReturnValue("/opt/openclaw/bin/openclaw");

    detectDuplicateInstallations();

    expect(mocks.note).not.toHaveBeenCalledWith(
      expect.stringContaining("Duplicate"),
      expect.anything(),
    );
  });

  it("detects duplicate installations at different realpaths", () => {
    mocks.existsSync.mockImplementation(
      (p: string) => p === "/usr/bin/openclaw" || p === "/home/testuser/.npm-global/bin/openclaw",
    );
    mocks.realpathSync.mockImplementation((p: string) => p);

    detectDuplicateInstallations();

    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Found 2 openclaw installations"),
      "Duplicate installations",
    );
  });

  it("includes version info from package.json", () => {
    mocks.existsSync.mockImplementation((p: string) => {
      if (p === "/usr/bin/openclaw") {
        return true;
      }
      if (p === "/usr/local/bin/openclaw") {
        return true;
      }
      if (p.endsWith("package.json")) {
        return true;
      }
      return false;
    });
    mocks.realpathSync.mockImplementation((p: string) => p);
    mocks.readFileSync.mockImplementation((p: string) => {
      if (p.includes("/usr/bin/")) {
        return JSON.stringify({ version: "2026.2.25" });
      }
      return JSON.stringify({ version: "2026.3.2" });
    });

    detectDuplicateInstallations();

    const call = mocks.note.mock.calls.find((c: unknown[]) => c[1] === "Duplicate installations");
    expect(call).toBeDefined();
    expect(call![0]).toContain("v2026.2.25");
    expect(call![0]).toContain("v2026.3.2");
  });

  it("includes remediation steps", () => {
    mocks.existsSync.mockImplementation(
      (p: string) => p === "/usr/bin/openclaw" || p === "/usr/local/bin/openclaw",
    );
    mocks.realpathSync.mockImplementation((p: string) => p);

    detectDuplicateInstallations();

    const call = mocks.note.mock.calls.find((c: unknown[]) => c[1] === "Duplicate installations");
    expect(call).toBeDefined();
    expect(call![0]).toContain("sudo npm uninstall -g openclaw");
    expect(call![0]).toContain("which openclaw");
  });

  it("reports duplicate systemd services when found", () => {
    mocks.existsSync.mockImplementation((p: string) => {
      if (p === "/usr/bin/openclaw") {
        return true;
      }
      if (p === "/usr/local/bin/openclaw") {
        return true;
      }
      if (p === "/etc/systemd/system") {
        return true;
      }
      if (p === "/home/testuser/.config/systemd/user") {
        return true;
      }
      return false;
    });
    mocks.realpathSync.mockImplementation((p: string) => p);
    mocks.readdirSync.mockImplementation((dir: string) => {
      if (dir === "/etc/systemd/system") {
        return ["openclaw.service"];
      }
      if (dir === "/home/testuser/.config/systemd/user") {
        return ["openclaw-gateway.service"];
      }
      return [];
    });

    detectDuplicateInstallations();

    const call = mocks.note.mock.calls.find((c: unknown[]) => c[1] === "Duplicate installations");
    expect(call).toBeDefined();
    expect(call![0]).toContain("openclaw.service");
    expect(call![0]).toContain("openclaw-gateway.service");
    expect(call![0]).toContain("2 OpenClaw-related systemd services");
  });
});
