import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS } from "../infra/windows-powershell-spawn.js";

const execMocks = vi.hoisted(() => ({
  runExec: vi.fn(),
}));

vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runExec: execMocks.runExec,
}));
vi.mock("../infra/resolve-system-bin.js", () => ({
  resolveSystemBin: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
}));

import { ensurePrivateSnapshotRepositoryRoot } from "./local-repository.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const CURRENT_USER_SID = "S-1-5-21-1000";

type WindowsAclProbeEntry = {
  accessType: "Allow" | "Deny";
  inheritanceFlags: string;
  principal: string;
  propagationFlags: string;
  rightsMask: number;
};

const CURRENT_USER_FULL_ACCESS: WindowsAclProbeEntry = {
  principal: CURRENT_USER_SID,
  accessType: "Allow",
  rightsMask: 0x1f01ff,
  inheritanceFlags: "None",
  propagationFlags: "None",
};

function mockWindowsPathSecurity(
  params: {
    ancestorEntries?: WindowsAclProbeEntry[];
    rootEntries?: WindowsAclProbeEntry[];
    rootOwnerSid?: string;
  } = {},
): void {
  execMocks.runExec.mockImplementation(async (_command, args) => {
    const encodedIndex = args.indexOf("-EncodedCommand");
    const encoded = args[encodedIndex + 1];
    if (typeof encoded !== "string") {
      throw new Error("expected encoded PowerShell command");
    }
    const command = Buffer.from(encoded, "base64").toString("utf16le");
    const pathsPayload = /FromBase64String\('([^']+)'\)/u.exec(command)?.[1];
    if (!pathsPayload) {
      throw new Error("expected encoded path payload");
    }
    const paths = JSON.parse(Buffer.from(pathsPayload, "base64").toString("utf8")) as string[];
    return {
      stdout: Buffer.from(
        JSON.stringify({
          currentUserSid: CURRENT_USER_SID,
          paths: paths.map((entry, index) => ({
            path: entry,
            ownerSid: index === 0 ? (params.rootOwnerSid ?? CURRENT_USER_SID) : CURRENT_USER_SID,
            entries:
              index === 0
                ? (params.rootEntries ?? [CURRENT_USER_FULL_ACCESS])
                : (params.ancestorEntries ?? [CURRENT_USER_FULL_ACCESS]),
          })),
        }),
        "utf8",
      ).toString("base64"),
    };
  });
}

describe("fail-closed Windows ACL probe", () => {
  it("budgets for cold PowerShell startup and sanitizes the spawn failure", async () => {
    const tempDir = tempDirs.make("openclaw-snapshot-windows-acl-probe-");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const encodedPayload = Buffer.from("private PowerShell script bytes").toString("base64");
    const command = `powershell.exe -EncodedCommand ${encodedPayload}`;
    const spawnError = Object.assign(
      new Error(`Command timed out after 60000 milliseconds: ${command}`),
      {
        code: "ETIMEDOUT",
        command,
        escapedCommand: command,
        killed: true,
        stderr: "boring stderr line\n-EncodedCommand secret",
      },
    );
    execMocks.runExec.mockRejectedValue(spawnError);

    const error = await ensurePrivateSnapshotRepositoryRoot(tempDir).catch(
      (cause: unknown) => cause,
    );

    expect(error).toMatchObject({
      message: expect.stringContaining("Unable to verify private Windows ACL for SQLite staging"),
    });
    const causes: Error[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      causes.push(current);
      current = (current as Error & { cause?: unknown }).cause;
    }
    expect(causes.map((cause) => cause.message).join("\n")).toContain(
      "Unable to verify private Windows ACL",
    );
    expect(causes.at(-1)?.message).toContain("code=ETIMEDOUT, killed=true");
    expect(causes.at(-1)?.message).toContain("stderr: boring stderr line");
    expect(causes).not.toContain(spawnError);
    for (const cause of causes) {
      const retainedText = Object.getOwnPropertyNames(cause)
        .map((key) => String((cause as unknown as Record<string, unknown>)[key]))
        .join("\n");
      expect(retainedText).not.toMatch(/encodedcommand/iu);
      expect(retainedText).not.toContain(encodedPayload);
    }
    expect(execMocks.runExec).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ timeoutMs: WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS }),
    );
  });

  it("names the untrusted root principal and rights without weakening rejection", async () => {
    const tempDir = tempDirs.make("openclaw-snapshot-windows-acl-detail-");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mockWindowsPathSecurity({
      rootEntries: [
        {
          principal: "S-1-1-0",
          accessType: "Allow",
          rightsMask: 0x120089,
          inheritanceFlags: "ContainerInherit, ObjectInherit",
          propagationFlags: "None",
        },
      ],
    });

    await expect(ensurePrivateSnapshotRepositoryRoot(tempDir)).rejects.toThrow(
      /repository root: path=.* principal=S-1-1-0 rights=.*Remove the untrusted grant/u,
    );
  });

  it("accepts a private local Windows repository root", async () => {
    const tempDir = tempDirs.make("openclaw-snapshot-windows-acl-private-");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mockWindowsPathSecurity();

    await expect(ensurePrivateSnapshotRepositoryRoot(tempDir)).resolves.toBe(tempDir);
  });

  it.each([
    { role: "root", rightsMask: 0x100000, inheritOnly: false, allowed: true },
    { role: "ancestor", rightsMask: 0x000001, inheritOnly: false, allowed: true },
    { role: "ancestor", rightsMask: 0x040000, inheritOnly: false, allowed: false },
    { role: "ancestor", rightsMask: 0x040000, inheritOnly: true, allowed: true },
    { role: "root", rightsMask: 0x040000, inheritOnly: true, allowed: false },
    { role: "root", rightsMask: 0x80000000, inheritOnly: false, allowed: false },
    { role: "ancestor", rightsMask: 0x000200, inheritOnly: false, allowed: false },
  ])("enforces $role access for mask $rightsMask with inheritOnly=$inheritOnly", async (row) => {
    const tempDir = tempDirs.make("openclaw-snapshot-windows-acl-rights-");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const entries: WindowsAclProbeEntry[] = [
      CURRENT_USER_FULL_ACCESS,
      {
        principal: "S-1-1-0",
        accessType: "Allow",
        rightsMask: row.rightsMask,
        inheritanceFlags: "ObjectInherit, ContainerInherit",
        propagationFlags: row.inheritOnly ? "InheritOnly" : "None",
      },
    ];
    mockWindowsPathSecurity(
      row.role === "root" ? { rootEntries: entries } : { ancestorEntries: entries },
    );
    const result = ensurePrivateSnapshotRepositoryRoot(tempDir);
    if (row.allowed) {
      await expect(result).resolves.toBe(tempDir);
    } else {
      await expect(result).rejects.toThrow("Windows ACL permits untrusted SQLite staging access");
    }
  });

  it.each([
    {
      label: "a OneDrive-style synced root",
      params: {
        rootEntries: [
          {
            principal: "S-1-1-0",
            accessType: "Allow" as const,
            rightsMask: 0x1f01ff,
            inheritanceFlags: "ContainerInherit, ObjectInherit",
            propagationFlags: "None",
          },
        ],
      },
      expected: /repository root: path=.*principal=S-1-1-0 rights=.*shared or synced root/u,
    },
    {
      label: "a network-share root owned by another principal",
      params: { rootOwnerSid: "S-1-5-21-2000" },
      expected:
        /repository root is owned by an untrusted principal: path=.*principal=S-1-5-21-2000/u,
    },
    {
      label: "an inherited shared ancestor grant",
      params: {
        ancestorEntries: [
          {
            principal: "S-1-1-0",
            accessType: "Allow" as const,
            rightsMask: 0x000040,
            inheritanceFlags: "ContainerInherit, ObjectInherit",
            propagationFlags: "None",
          },
        ],
      },
      expected: /ancestor: path=.*principal=S-1-1-0 rights=.*shared or synced root/u,
    },
  ])("rejects $label", async ({ params, expected }) => {
    const tempDir = tempDirs.make("openclaw-snapshot-windows-acl-matrix-");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mockWindowsPathSecurity(params);

    await expect(ensurePrivateSnapshotRepositoryRoot(tempDir)).rejects.toThrow(expected);
  });
});
