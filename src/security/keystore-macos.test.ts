import { execFileSync } from "node:child_process";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const execFileSyncMock = vi.mocked(execFileSync);

// Import after mock is in place.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let macosKeystoreBackend: (typeof import("./keystore-macos.js"))["macosKeystoreBackend"];

beforeEach(async () => {
  vi.resetModules();
  execFileSyncMock.mockReset();
  const mod = await import("./keystore-macos.js");
  macosKeystoreBackend = mod.macosKeystoreBackend;
});

describe("macosKeystoreBackend.isAvailable", () => {
  it("returns true when security help succeeds", () => {
    execFileSyncMock.mockReturnValue("Usage: security ...");
    expect(macosKeystoreBackend.isAvailable()).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "security",
      ["help"],
      expect.objectContaining({ encoding: "utf8", timeout: 5000 }),
    );
  });

  it("returns false when security binary throws", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("command not found");
    });
    expect(macosKeystoreBackend.isAvailable()).toBe(false);
  });
});

describe("macosKeystoreBackend.store", () => {
  it("returns true on success and passes correct arguments", () => {
    execFileSyncMock.mockReturnValue("");
    const result = macosKeystoreBackend.store("my-service", "my-account", "secret-value");
    expect(result).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "security",
      ["add-generic-password", "-U", "-s", "my-service", "-a", "my-account", "-w", "secret-value"],
      expect.objectContaining({ encoding: "utf8", timeout: 5000 }),
    );
  });

  it("returns false when store throws", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("keychain locked");
    });
    expect(macosKeystoreBackend.store("svc", "acct", "val")).toBe(false);
  });
});

describe("macosKeystoreBackend.retrieve", () => {
  it("returns the trimmed value on success", () => {
    execFileSyncMock.mockReturnValue("  secret-value\n");
    const result = macosKeystoreBackend.retrieve("my-service", "my-account");
    expect(result).toBe("secret-value");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", "my-service", "-a", "my-account", "-w"],
      expect.objectContaining({ encoding: "utf8", timeout: 5000 }),
    );
  });

  it("returns null when item not found", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("The specified item could not be found");
    });
    expect(macosKeystoreBackend.retrieve("svc", "acct")).toBeNull();
  });
});

describe("macosKeystoreBackend.delete", () => {
  it("returns true on success", () => {
    execFileSyncMock.mockReturnValue("");
    const result = macosKeystoreBackend.delete("my-service", "my-account");
    expect(result).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "security",
      ["delete-generic-password", "-s", "my-service", "-a", "my-account"],
      expect.objectContaining({ encoding: "utf8", timeout: 5000 }),
    );
  });

  it("returns false when delete throws", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("item not found");
    });
    expect(macosKeystoreBackend.delete("svc", "acct")).toBe(false);
  });
});
