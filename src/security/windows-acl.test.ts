import { describe, expect, it, vi } from "vitest";
import type { WindowsAclEntry, WindowsAclSummary } from "./windows-acl.js";

const MOCK_USERNAME = "MockUser";

vi.mock("node:os", () => ({
  default: { userInfo: () => ({ username: MOCK_USERNAME }) },
  userInfo: () => ({ username: MOCK_USERNAME }),
}));

const {
  createIcaclsResetCommand,
  formatIcaclsResetCommand,
  formatWindowsAclSummary,
  inspectWindowsAcl,
  parseIcaclsOutput,
  resolveWindowsUserPrincipal,
  summarizeWindowsAcl,
} = await import("./windows-acl.js");

describe("windows-acl", () => {
  describe("resolveWindowsUserPrincipal", () => {
    it("returns DOMAIN\\USERNAME when both are present", () => {
      const env = { USERNAME: "TestUser", USERDOMAIN: "WORKGROUP" };
      expect(resolveWindowsUserPrincipal(env)).toBe("WORKGROUP\\TestUser");
    });

    it("returns just USERNAME when USERDOMAIN is not present", () => {
      const env = { USERNAME: "TestUser" };
      expect(resolveWindowsUserPrincipal(env)).toBe("TestUser");
    });

    it("trims whitespace from values", () => {
      const env = { USERNAME: "  TestUser  ", USERDOMAIN: "  WORKGROUP  " };
      expect(resolveWindowsUserPrincipal(env)).toBe("WORKGROUP\\TestUser");
    });

    it("falls back to os.userInfo when USERNAME is empty", () => {
      // When USERNAME env is empty, falls back to os.userInfo().username
      const env = { USERNAME: "", USERDOMAIN: "WORKGROUP" };
      const result = resolveWindowsUserPrincipal(env);
      // Should return a username (from os.userInfo fallback) with WORKGROUP domain
      expect(result).toBe(`WORKGROUP\\${MOCK_USERNAME}`);
    });
  });

  describe("parseIcaclsOutput", () => {
    it("parses standard icacls output", () => {
      const output = `C:\\test\\file.txt BUILTIN\\Administrators:(F)
                     NT AUTHORITY\\SYSTEM:(F)
                     WORKGROUP\\TestUser:(R)

Successfully processed 1 files`;
      const entries = parseIcaclsOutput(output, "C:\\test\\file.txt");
      expect(entries).toHaveLength(3);
      expect(entries[0]).toEqual({
        principal: "BUILTIN\\Administrators",
        rights: ["F"],
        rawRights: "(F)",
        canRead: true,
        canWrite: true,
      });
    });

    it("parses entries with inheritance flags", () => {
      const output = `C:\\test\\dir BUILTIN\\Users:(OI)(CI)(R)`;
      const entries = parseIcaclsOutput(output, "C:\\test\\dir");
      expect(entries).toHaveLength(1);
      expect(entries[0].rights).toEqual(["R"]);
      expect(entries[0].canRead).toBe(true);
      expect(entries[0].canWrite).toBe(false);
    });

    it("filters out DENY entries", () => {
      const output = `C:\\test\\file.txt BUILTIN\\Users:(DENY)(W)
                     BUILTIN\\Administrators:(F)`;
      const entries = parseIcaclsOutput(output, "C:\\test\\file.txt");
      expect(entries).toHaveLength(1);
      expect(entries[0].principal).toBe("BUILTIN\\Administrators");
    });

    it("skips status messages", () => {
      const output = `Successfully processed 1 files
                     Failed processing 0 files
                     No mapping between account names`;
      const entries = parseIcaclsOutput(output, "C:\\test\\file.txt");
      expect(entries).toHaveLength(0);
    });

    it("handles quoted target paths", () => {
      const output = `"C:\\path with spaces\\file.txt" BUILTIN\\Administrators:(F)`;
      const entries = parseIcaclsOutput(output, "C:\\path with spaces\\file.txt");
      expect(entries).toHaveLength(1);
    });

    it("detects write permissions correctly", () => {
      // F = Full control (read + write)
      // M = Modify (read + write)
      // W = Write
      // D = Delete (considered write)
      // R = Read only
      const testCases = [
        { rights: "(F)", canWrite: true, canRead: true },
        { rights: "(M)", canWrite: true, canRead: true },
        { rights: "(W)", canWrite: true, canRead: false },
        { rights: "(D)", canWrite: true, canRead: false },
        { rights: "(R)", canWrite: false, canRead: true },
        { rights: "(RX)", canWrite: false, canRead: true },
      ];

      for (const tc of testCases) {
        const output = `C:\\test\\file.txt BUILTIN\\Users:${tc.rights}`;
        const entries = parseIcaclsOutput(output, "C:\\test\\file.txt");
        expect(entries[0].canWrite).toBe(tc.canWrite);
        expect(entries[0].canRead).toBe(tc.canRead);
      }
    });
  });

  describe("summarizeWindowsAcl", () => {
    it("classifies trusted principals", () => {
      const entries: WindowsAclEntry[] = [
        {
          principal: "NT AUTHORITY\\SYSTEM",
          rights: ["F"],
          rawRights: "(F)",
          canRead: true,
          canWrite: true,
        },
        {
          principal: "BUILTIN\\Administrators",
          rights: ["F"],
          rawRights: "(F)",
          canRead: true,
          canWrite: true,
        },
      ];
      const summary = summarizeWindowsAcl(entries);
      expect(summary.trusted).toHaveLength(2);
      expect(summary.untrustedWorld).toHaveLength(0);
      expect(summary.untrustedGroup).toHaveLength(0);
    });

    it("classifies world principals", () => {
      const entries: WindowsAclEntry[] = [
        {
          principal: "Everyone",
          rights: ["R"],
          rawRights: "(R)",
          canRead: true,
          canWrite: false,
        },
        {
          principal: "BUILTIN\\Users",
          rights: ["R"],
          rawRights: "(R)",
          canRead: true,
          canWrite: false,
        },
      ];
      const summary = summarizeWindowsAcl(entries);
      expect(summary.trusted).toHaveLength(0);
      expect(summary.untrustedWorld).toHaveLength(2);
      expect(summary.untrustedGroup).toHaveLength(0);
    });

    it("classifies current user as trusted", () => {
      const entries: WindowsAclEntry[] = [
        {
          principal: "WORKGROUP\\TestUser",
          rights: ["F"],
          rawRights: "(F)",
          canRead: true,
          canWrite: true,
        },
      ];
      const env = { USERNAME: "TestUser", USERDOMAIN: "WORKGROUP" };
      const summary = summarizeWindowsAcl(entries, env);
      expect(summary.trusted).toHaveLength(1);
    });

    it("classifies unknown principals as group", () => {
      const entries: WindowsAclEntry[] = [
        {
          principal: "DOMAIN\\SomeOtherUser",
          rights: ["R"],
          rawRights: "(R)",
          canRead: true,
          canWrite: false,
        },
      ];
      const env = { USERNAME: "TestUser", USERDOMAIN: "WORKGROUP" };
      const summary = summarizeWindowsAcl(entries, env);
      expect(summary.untrustedGroup).toHaveLength(1);
    });
  });

  describe("inspectWindowsAcl", () => {
    it("returns parsed ACL entries on success", async () => {
      const mockExec = vi.fn().mockResolvedValue({
        stdout: `C:\\test\\file.txt BUILTIN\\Administrators:(F)
                NT AUTHORITY\\SYSTEM:(F)`,
        stderr: "",
      });

      const result = await inspectWindowsAcl("C:\\test\\file.txt", { exec: mockExec });
      expect(result.ok).toBe(true);
      expect(result.entries).toHaveLength(2);
      expect(mockExec).toHaveBeenCalledWith("icacls", ["C:\\test\\file.txt"]);
    });

    it("returns error state on exec failure", async () => {
      const mockExec = vi.fn().mockRejectedValue(new Error("icacls not found"));

      const result = await inspectWindowsAcl("C:\\test\\file.txt", { exec: mockExec });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("icacls not found");
      expect(result.entries).toHaveLength(0);
    });

    it("combines stdout and stderr for parsing", async () => {
      const mockExec = vi.fn().mockResolvedValue({
        stdout: "C:\\test\\file.txt BUILTIN\\Administrators:(F)",
        stderr: "C:\\test\\file.txt NT AUTHORITY\\SYSTEM:(F)",
      });

      const result = await inspectWindowsAcl("C:\\test\\file.txt", { exec: mockExec });
      expect(result.ok).toBe(true);
      expect(result.entries).toHaveLength(2);
    });
  });

  describe("formatWindowsAclSummary", () => {
    it("returns 'unknown' for failed summary", () => {
      const summary: WindowsAclSummary = {
        ok: false,
        entries: [],
        trusted: [],
        untrustedWorld: [],
        untrustedGroup: [],
        error: "icacls failed",
      };
      expect(formatWindowsAclSummary(summary)).toBe("unknown");
    });

    it("returns 'trusted-only' when no untrusted entries", () => {
      const summary: WindowsAclSummary = {
        ok: true,
        entries: [],
        trusted: [
          {
            principal: "BUILTIN\\Administrators",
            rights: ["F"],
            rawRights: "(F)",
            canRead: true,
            canWrite: true,
          },
        ],
        untrustedWorld: [],
        untrustedGroup: [],
      };
      expect(formatWindowsAclSummary(summary)).toBe("trusted-only");
    });

    it("formats untrusted entries", () => {
      const summary: WindowsAclSummary = {
        ok: true,
        entries: [],
        trusted: [],
        untrustedWorld: [
          {
            principal: "Everyone",
            rights: ["R"],
            rawRights: "(R)",
            canRead: true,
            canWrite: false,
          },
        ],
        untrustedGroup: [
          {
            principal: "DOMAIN\\OtherUser",
            rights: ["M"],
            rawRights: "(M)",
            canRead: true,
            canWrite: true,
          },
        ],
      };
      const result = formatWindowsAclSummary(summary);
      expect(result).toBe("Everyone:(R), DOMAIN\\OtherUser:(M)");
    });
  });

  describe("formatIcaclsResetCommand", () => {
    it("generates command for files", () => {
      const env = { USERNAME: "TestUser", USERDOMAIN: "WORKGROUP" };
      const result = formatIcaclsResetCommand("C:\\test\\file.txt", { isDir: false, env });
      expect(result).toBe(
        'icacls "C:\\test\\file.txt" /inheritance:r /grant:r "WORKGROUP\\TestUser:F" /grant:r "SYSTEM:F"',
      );
    });

    it("generates command for directories with inheritance flags", () => {
      const env = { USERNAME: "TestUser", USERDOMAIN: "WORKGROUP" };
      const result = formatIcaclsResetCommand("C:\\test\\dir", { isDir: true, env });
      expect(result).toContain("(OI)(CI)F");
    });

    it("uses system username when env is empty (falls back to os.userInfo)", () => {
      // When env is empty, resolveWindowsUserPrincipal falls back to os.userInfo().username
      const result = formatIcaclsResetCommand("C:\\test\\file.txt", { isDir: false, env: {} });
      // Should contain the actual system username from os.userInfo
      expect(result).toContain(`"${MOCK_USERNAME}:F"`);
      expect(result).not.toContain("%USERNAME%");
    });
  });

  describe("createIcaclsResetCommand", () => {
    it("returns structured command object", () => {
      const env = { USERNAME: "TestUser", USERDOMAIN: "WORKGROUP" };
      const result = createIcaclsResetCommand("C:\\test\\file.txt", { isDir: false, env });
      expect(result).not.toBeNull();
      expect(result?.command).toBe("icacls");
      expect(result?.args).toContain("C:\\test\\file.txt");
      expect(result?.args).toContain("/inheritance:r");
    });

    it("returns command with system username when env is empty (falls back to os.userInfo)", () => {
      // When env is empty, resolveWindowsUserPrincipal falls back to os.userInfo().username
      const result = createIcaclsResetCommand("C:\\test\\file.txt", { isDir: false, env: {} });
      // Should return a valid command using the system username
      expect(result).not.toBeNull();
      expect(result?.command).toBe("icacls");
      expect(result?.args).toContain(`${MOCK_USERNAME}:F`);
    });

    it("includes display string matching formatIcaclsResetCommand", () => {
      const env = { USERNAME: "TestUser", USERDOMAIN: "WORKGROUP" };
      const result = createIcaclsResetCommand("C:\\test\\file.txt", { isDir: false, env });
      const expected = formatIcaclsResetCommand("C:\\test\\file.txt", { isDir: false, env });
      expect(result?.display).toBe(expected);
    });
  });
});
