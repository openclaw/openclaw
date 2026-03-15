/* oxlint-disable typescript/no-explicit-any */
import * as child_process from "node:child_process";
import * as os from "node:os";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  detectPlatform,
  keychainDelete,
  keychainGet,
  keychainList,
  keychainSet,
} from "./keychain.js";

// Mock child_process.exec and spawn
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof child_process>("node:child_process");
  return {
    ...actual,
    exec: vi.fn(),
    spawn: vi.fn(),
  };
});

// Mock os.platform — include default export for CJS interop (keychain.ts uses default import)
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof os>("node:os");
  const mocked = { ...actual, platform: vi.fn() };
  return { ...mocked, default: mocked };
});

const mockedExec = vi.mocked(child_process.exec);
const mockedSpawn = vi.mocked(child_process.spawn);
const mockedPlatform = vi.mocked(os.platform);

describe("keychain module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("detectPlatform", () => {
    test("returns darwin for macOS", () => {
      mockedPlatform.mockReturnValue("darwin");
      expect(detectPlatform()).toBe("darwin");
    });

    test("returns linux for Linux", () => {
      mockedPlatform.mockReturnValue("linux");
      expect(detectPlatform()).toBe("linux");
    });

    test("returns win32 for Windows", () => {
      mockedPlatform.mockReturnValue("win32");
      expect(detectPlatform()).toBe("win32");
    });

    test("returns unsupported for other platforms", () => {
      mockedPlatform.mockReturnValue("freebsd");
      expect(detectPlatform()).toBe("unsupported");

      mockedPlatform.mockReturnValue("aix");
      expect(detectPlatform()).toBe("unsupported");
    });
  });

  describe("keychainGet - macOS", () => {
    beforeEach(() => {
      mockedPlatform.mockReturnValue("darwin");
    });

    test("retrieves secret from macOS keychain", async () => {
      mockedExec.mockImplementation((cmd, options, callback) => {
        if (typeof callback === "function") {
          callback(null, { stdout: "my-secret-value\n", stderr: "" } as any, "");
        }
        return {} as any;
      });

      const result = await keychainGet("test-key");

      expect(result).toBe("my-secret-value");
      expect(mockedExec).toHaveBeenCalledWith(
        expect.stringContaining("security find-generic-password"),
        expect.any(Object),
        expect.any(Function),
      );
    });

    test("constructs correct macOS security command", async () => {
      mockedExec.mockImplementation((cmd, options, callback) => {
        if (typeof callback === "function") {
          callback(null, { stdout: "value\n", stderr: "" } as any, "");
        }
        return {} as any;
      });

      await keychainGet("my-key");

      const call = mockedExec.mock.calls[0];
      const command = call[0];

      expect(command).toContain("security find-generic-password");
      expect(command).toContain('-s "openclaw-secrets"');
      expect(command).toContain('-a "mykey"'); // Sanitized (dash removed)
      expect(command).toContain("-w");
    });

    test("returns null when secret not found on macOS", async () => {
      mockedExec.mockImplementation((cmd, options, callback) => {
        if (typeof callback === "function") {
          const error = new Error(
            "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
          );
          callback(error as any, { stdout: "", stderr: "" } as any, "");
        }
        return {} as any;
      });

      const result = await keychainGet("nonexistent");

      expect(result).toBeNull();
    });

    test("sanitizes secret name on macOS", async () => {
      mockedExec.mockImplementation((cmd, options, callback) => {
        if (typeof callback === "function") {
          callback(null, { stdout: "value\n", stderr: "" } as any, "");
        }
        return {} as any;
      });

      await keychainGet("my-key!@#$%");

      const call = mockedExec.mock.calls[0];
      const command = call[0];

      // Should strip dangerous characters
      expect(command).toContain('-a "mykey@"');
    });
  });

  describe("keychainSet - macOS", () => {
    beforeEach(() => {
      mockedPlatform.mockReturnValue("darwin");
    });

    test("stores secret in macOS keychain", async () => {
      let deleteCallCount = 0;
      let addCallCount = 0;

      mockedExec.mockImplementation((cmd, options, callback) => {
        const command = cmd;
        if (command.includes("delete-generic-password")) {
          deleteCallCount++;
          if (typeof callback === "function") {
            callback(null, { stdout: "", stderr: "" } as any, "");
          }
        } else if (command.includes("add-generic-password")) {
          addCallCount++;
          if (typeof callback === "function") {
            callback(null, { stdout: "", stderr: "" } as any, "");
          }
        }
        return {} as any;
      });

      await keychainSet("test-key", "secret-value");

      expect(deleteCallCount).toBe(1);
      expect(addCallCount).toBe(1);
    });

    test("constructs correct macOS add command", async () => {
      mockedExec.mockImplementation((cmd, options, callback) => {
        if (typeof callback === "function") {
          callback(null, { stdout: "", stderr: "" } as any, "");
        }
        return {} as any;
      });

      await keychainSet("my-key", "my-value");

      const addCall = mockedExec.mock.calls.find((call) =>
        call[0].includes("add-generic-password"),
      );

      expect(addCall).toBeDefined();
      const command = addCall![0];
      expect(command).toContain("security add-generic-password");
      expect(command).toContain('-s "openclaw-secrets"');
      expect(command).toContain('-a "mykey"');
      expect(command).toContain("-w");
      expect(command).toContain("-U"); // Update flag
    });

    test("passes value as -w argument on macOS", async () => {
      mockedExec.mockImplementation((cmd, options, callback) => {
        if (typeof callback === "function") {
          callback(null, { stdout: "", stderr: "" } as any, "");
        }
        return {} as any;
      });

      await keychainSet("test", "secret123");

      const addCall = mockedExec.mock.calls.find((call) =>
        call[0].includes("add-generic-password"),
      );
      expect(addCall).toBeDefined();
      const command = addCall![0];

      // macOS security CLI uses -w flag (not stdin) for password
      expect(command).toContain('-w "secret123"');
    });
  });

  describe("keychainDelete - macOS", () => {
    beforeEach(() => {
      mockedPlatform.mockReturnValue("darwin");
    });

    test("deletes secret from macOS keychain", async () => {
      mockedExec.mockImplementation((cmd, options, callback) => {
        if (typeof callback === "function") {
          callback(null, { stdout: "", stderr: "" } as any, "");
        }
        return {} as any;
      });

      await keychainDelete("test-key");

      expect(mockedExec).toHaveBeenCalledWith(
        expect.stringContaining("security delete-generic-password"),
        expect.any(Object),
        expect.any(Function),
      );
    });

    test("succeeds silently when item doesn't exist", async () => {
      mockedExec.mockImplementation((cmd, options, callback) => {
        if (typeof callback === "function") {
          const error = new Error("Item not found");
          callback(error as any, { stdout: "", stderr: "" } as any, "");
        }
        return {} as any;
      });

      await expect(keychainDelete("nonexistent")).resolves.not.toThrow();
    });
  });

  describe("keychainGet - Linux", () => {
    beforeEach(() => {
      mockedPlatform.mockReturnValue("linux");
    });

    test("retrieves secret using secret-tool", async () => {
      mockedExec.mockImplementation((cmd, options, callback) => {
        if (typeof callback === "function") {
          callback(null, { stdout: "linux-secret\n", stderr: "" } as any, "");
        }
        return {} as any;
      });

      const result = await keychainGet("linux-key");

      expect(result).toBe("linux-secret");
      const call = mockedExec.mock.calls[0];
      const command = call[0];
      expect(command).toContain("secret-tool lookup");
      expect(command).toContain('service "openclaw-secrets"');
      expect(command).toContain('account "linuxkey"');
    });

    test("returns null when secret not found on Linux", async () => {
      mockedExec.mockImplementation((cmd, options, callback) => {
        if (typeof callback === "function") {
          const error = new Error("no such item");
          callback(error as any, { stdout: "", stderr: "" } as any, "");
        }
        return {} as any;
      });

      const result = await keychainGet("missing");

      expect(result).toBeNull();
    });
  });

  describe("keychainSet - Linux", () => {
    beforeEach(() => {
      mockedPlatform.mockReturnValue("linux");
    });

    test("stores secret using secret-tool via spawn", async () => {
      // keychainSetLinux uses execWithStdin (spawn) to pipe value via stdin
      const mockStdin = { write: vi.fn(), end: vi.fn() };
      const mockStdout = { on: vi.fn() };
      const mockStderr = { on: vi.fn() };
      const mockProcess = {
        stdin: mockStdin,
        stdout: mockStdout,
        stderr: mockStderr,
        on: vi.fn((event: string, cb: (code: number) => void) => {
          if (event === "close") cb(0);
        }),
      };
      mockedSpawn.mockReturnValue(mockProcess as any);

      await keychainSet("linux-key", "linux-value");

      expect(mockedSpawn).toHaveBeenCalled();
      const spawnCall = mockedSpawn.mock.calls[0];
      const command = spawnCall[0] as string;
      expect(command).toContain("secret-tool store");
      expect(command).toContain('--label="openclaw-secrets: linuxkey"');
      expect(command).toContain('service "openclaw-secrets"');
      expect(command).toContain('account "linuxkey"');
      // Value is piped via stdin
      expect(mockStdin.write).toHaveBeenCalledWith("linux-value");
    });
  });

  describe("keychainDelete - Linux", () => {
    beforeEach(() => {
      mockedPlatform.mockReturnValue("linux");
    });

    test("deletes secret using secret-tool", async () => {
      mockedExec.mockImplementation((cmd, options, callback) => {
        if (typeof callback === "function") {
          callback(null, { stdout: "", stderr: "" } as any, "");
        }
        return {} as any;
      });

      await keychainDelete("linux-key");

      const call = mockedExec.mock.calls[0];
      const command = call[0];
      expect(command).toContain("secret-tool clear");
      expect(command).toContain('service "openclaw-secrets"');
      expect(command).toContain('account "linuxkey"');
    });
  });

  describe("keychainGet - Windows", () => {
    beforeEach(() => {
      mockedPlatform.mockReturnValue("win32");
    });

    test("retrieves secret using PowerShell CredRead", async () => {
      mockedExec.mockImplementation((cmd, options, callback) => {
        if (typeof callback === "function") {
          callback(null, { stdout: "windows-secret\r\n", stderr: "" } as any, "");
        }
        return {} as any;
      });

      const result = await keychainGet("win-key");

      expect(result).toBe("windows-secret");
      const call = mockedExec.mock.calls[0];
      const command = call[0];
      expect(command).toContain("powershell.exe");
      // Implementation uses a temp .ps1 file to avoid escaping issues
      expect(command).toContain("-File");
    });

    test("returns null when credential not found on Windows", async () => {
      mockedExec.mockImplementation((cmd, options, callback) => {
        if (typeof callback === "function") {
          const error = new Error("Credential not found");
          callback(error as any, { stdout: "", stderr: "" } as any, "");
        }
        return {} as any;
      });

      const result = await keychainGet("missing");

      expect(result).toBeNull();
    });
  });

  describe("keychainSet - Windows", () => {
    beforeEach(() => {
      mockedPlatform.mockReturnValue("win32");
    });

    test("stores secret using cmdkey via PowerShell", async () => {
      let deleteCallCount = 0;
      let addCallCount = 0;

      mockedExec.mockImplementation((cmd, options, callback) => {
        const command = cmd;
        if (command.includes("cmdkey /delete")) {
          deleteCallCount++;
        } else if (command.includes("cmdkey /generic")) {
          addCallCount++;
        }
        if (typeof callback === "function") {
          callback(null, { stdout: "", stderr: "" } as any, "");
        }
        return {} as any;
      });

      await keychainSet("win-key", "win-value");

      expect(deleteCallCount).toBeGreaterThanOrEqual(1);
      expect(addCallCount).toBe(1);
    });

    test("passes value as /pass argument on Windows", async () => {
      mockedExec.mockImplementation((cmd, options, callback) => {
        if (typeof callback === "function") {
          callback(null, { stdout: "", stderr: "" } as any, "");
        }
        return {} as any;
      });

      await keychainSet("test", "secret456");

      const setCall = mockedExec.mock.calls.find((call) => call[0].includes("cmdkey /generic"));

      expect(setCall).toBeDefined();
      const command = setCall![0];
      // Windows cmdkey uses /pass flag (not stdin) for password
      expect(command).toContain('/pass:"secret456"');
    });
  });

  describe("keychainDelete - Windows", () => {
    beforeEach(() => {
      mockedPlatform.mockReturnValue("win32");
    });

    test("deletes credential using cmdkey", async () => {
      mockedExec.mockImplementation((cmd, options, callback) => {
        if (typeof callback === "function") {
          callback(null, { stdout: "", stderr: "" } as any, "");
        }
        return {} as any;
      });

      await keychainDelete("win-key");

      const call = mockedExec.mock.calls[0];
      const command = call[0];
      expect(command).toContain("cmdkey /delete:");
      expect(command).toContain("openclaw-secrets:winkey");
    });
  });

  describe("keychainList", () => {
    test("lists secrets on macOS", async () => {
      mockedPlatform.mockReturnValue("darwin");
      mockedExec.mockImplementation((cmd, options, callback) => {
        if (typeof callback === "function") {
          callback(null, { stdout: "key1\nkey2\nkey3\n", stderr: "" } as any, "");
        }
        return {} as any;
      });

      const keys = await keychainList();

      expect(keys).toEqual(["key1", "key2", "key3"]);
    });

    test("lists secrets on Linux", async () => {
      mockedPlatform.mockReturnValue("linux");
      mockedExec.mockImplementation((cmd, options, callback) => {
        if (typeof callback === "function") {
          callback(null, { stdout: "secret-a\nsecret-b\n", stderr: "" } as any, "");
        }
        return {} as any;
      });

      const keys = await keychainList();

      expect(keys).toEqual(["secret-a", "secret-b"]);
    });

    test("lists credentials on Windows", async () => {
      mockedPlatform.mockReturnValue("win32");
      mockedExec.mockImplementation((cmd, options, callback) => {
        if (typeof callback === "function") {
          callback(null, { stdout: "cred1\r\ncred2\r\n", stderr: "" } as any, "");
        }
        return {} as any;
      });

      const keys = await keychainList();

      expect(keys).toEqual(["cred1", "cred2"]);
    });

    test("returns empty array on error", async () => {
      mockedPlatform.mockReturnValue("darwin");
      mockedExec.mockImplementation((cmd, options, callback) => {
        if (typeof callback === "function") {
          callback(new Error("Failed") as any, { stdout: "", stderr: "" } as any, "");
        }
        return {} as any;
      });

      const keys = await keychainList();

      expect(keys).toEqual([]);
    });
  });

  describe("unsupported platform", () => {
    beforeEach(() => {
      mockedPlatform.mockReturnValue("freebsd");
    });

    test("throws on unsupported platform for get", async () => {
      await expect(keychainGet("key")).rejects.toThrow("not supported");
    });

    test("throws on unsupported platform for set", async () => {
      await expect(keychainSet("key", "value")).rejects.toThrow("not supported");
    });

    test("throws on unsupported platform for delete", async () => {
      await expect(keychainDelete("key")).rejects.toThrow("not supported");
    });

    test("throws on unsupported platform for list", async () => {
      await expect(keychainList()).rejects.toThrow("not supported");
    });
  });

  describe("name sanitization", () => {
    beforeEach(() => {
      mockedPlatform.mockReturnValue("darwin");
      mockedExec.mockImplementation((cmd, options, callback) => {
        if (typeof callback === "function") {
          callback(null, { stdout: "value", stderr: "" } as any, "");
        }
        return {} as any;
      });
    });

    test("strips shell metacharacters", async () => {
      await keychainGet("key;rm -rf /");

      const call = mockedExec.mock.calls[0];
      const command = call[0];
      // Semicolons and slashes should be stripped
      expect(command).toContain("keyrmrf");
    });

    test("preserves allowed characters", async () => {
      await keychainGet("my-key_123:test@example.com");

      const call = mockedExec.mock.calls[0];
      const command = call[0];
      expect(command).toContain("mykey_123:test@example.com");
    });

    test("handles empty string after sanitization", async () => {
      await keychainGet("!@#$%^&*()");

      const call = mockedExec.mock.calls[0];
      const command = call[0];
      // All dangerous chars stripped except @
      expect(command).toContain('-a "@"');
    });
  });
});
