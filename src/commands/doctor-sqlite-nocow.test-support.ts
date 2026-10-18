import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, vi } from "vitest";
import { isSqlitePathOnBtrfs, setSqliteDirectoryNoCow } from "../infra/sqlite-wal-filesystem.js";

export const baseAcl = "user::rwx\ngroup::r-x\nother::---";
export const inheritedDefaultAcl =
  "default:user::rwx\ndefault:user:12345:rwx\ndefault:group::r-x\ndefault:mask::rwx\ndefault:other::---";
const nativeStatfs = fs.statfsSync;

export function createDoctorNoCowToolFixture(root: string, nativeSpawnSync?: typeof spawnSync) {
  const fixture = {
    tools: "ok" as "ok" | "unavailable" | "busy" | "exchange-failed" | "exchange-timeout",
    attributes: false,
    exchanges: 0,
    acls: new Map<string, string>(),
    unavailableAclTool: undefined as "getfacl" | "setfacl" | undefined,
    rejectAclVerification: false,
    verifyPrivateAclBoundary: false,
    beforeExchange: undefined as (() => void) | undefined,
    fuserResult: undefined as SpawnSyncReturns<string> | undefined,
  };
  function permissions(bits: number): string {
    return `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${bits & 1 ? "x" : "-"}`;
  }

  function modeFromAcl(acl: string): number {
    const entryBits = (tag: string) => {
      const value =
        acl
          .split("\n")
          .find((line) => line.startsWith(`${tag}::`))
          ?.split(":")[2] ?? "---";
      return (
        (value.includes("r") ? 4 : 0) |
        (value.includes("w") ? 2 : 0) |
        (value.includes("x") ? 1 : 0)
      );
    };
    return (
      (entryBits("user") << 6) |
      (entryBits(acl.includes("\nmask::") ? "mask" : "group") << 3) |
      entryBits("other")
    );
  }

  function observedAcl(pathname: string): string {
    const stat = fs.statSync(pathname);
    const owner = permissions((stat.mode >> 6) & 7);
    const group = permissions((stat.mode >> 3) & 7);
    const other = permissions(stat.mode & 7);
    const acl =
      fixture.acls.get(pathname) ??
      (pathname.includes(".nocow-backup-")
        ? `user::${owner}\nuser:12345:rwx\ngroup::r-x\nmask::${group}\nother::${other}${stat.isDirectory() ? `\n${inheritedDefaultAcl}` : ""}`
        : `user::${owner}\ngroup::${group}\nother::${other}`);
    const masked = acl.includes("\nmask::");
    return acl
      .split("\n")
      .map((line) =>
        line.startsWith("user::")
          ? `user::${owner}`
          : line.startsWith("mask::")
            ? `mask::${group}`
            : line.startsWith("group::") && !masked
              ? `group::${group}`
              : line.startsWith("other::")
                ? `other::${other}`
                : line,
      )
      .join("\n");
  }

  vi.mocked(isSqlitePathOnBtrfs).mockReturnValue(true);
  vi.mocked(setSqliteDirectoryNoCow).mockImplementation((dir) => {
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
  vi.mocked(spawnSync).mockImplementation((command, args, options) => {
    const argv = args ?? [];
    let stdout = "";
    let status = 0;
    if (command === "lsattr") {
      stdout = `${fixture.attributes || String(argv.at(-1)).includes(".nocow-backup-") ? "-------C------" : "--------------"} ${argv.at(-1)}`;
      if (fixture.tools === "unavailable") {
        status = 127;
      }
    } else if (command === "getfacl" || command === "setfacl") {
      expect(options?.env?.POSIXLY_CORRECT).toBeUndefined();
      const pathname = String(argv.at(-1));
      const existing = observedAcl(pathname);
      if (fixture.unavailableAclTool === command) {
        status = 127;
      } else if (command === "getfacl") {
        expect(argv.slice(0, 2)).toEqual(["-cEpn", "--"]);
        stdout = existing;
      } else if (argv[0] === "-k") {
        fixture.acls.set(
          pathname,
          existing
            .split("\n")
            .filter((line) => !line.startsWith("default:"))
            .join("\n"),
        );
      } else {
        expect(argv.slice(0, 3)).toEqual(["-n", "--set-file=-", "--"]);
        if (typeof options?.input !== "string") {
          throw new Error("Expected textual ACL input");
        }
        const input = options.input.trim();
        if (fixture.verifyPrivateAclBoundary && fs.statSync(pathname).isDirectory()) {
          expect(fs.statSync(pathname).mode & 0o077).toBe(0);
          expect(input).toContain("user:12345:---");
        }
        const defaults = existing.split("\n").filter((line) => line.startsWith("default:"));
        fixture.acls.set(
          pathname,
          fixture.rejectAclVerification
            ? baseAcl
            : input.includes("default:")
              ? input
              : [input, ...defaults].join("\n"),
        );
        const applied = fixture.acls.get(pathname)!;
        fs.chmodSync(pathname, (fs.statSync(pathname).mode & 0o7000) | modeFromAcl(applied));
      }
    } else if (command === "fuser" && fixture.fuserResult) {
      return fixture.fuserResult;
    } else if (command === "fuser" && !nativeSpawnSync) {
      expect(argv.length).toBeGreaterThan(0);
      expect(argv.every((argument) => path.isAbsolute(argument))).toBe(true);
      status = fixture.tools === "busy" ? 0 : 1;
      stdout = fixture.tools === "busy" ? "12345" : "";
    } else if (command === "mv" && argv[0] === "--help") {
      stdout = fixture.tools === "unavailable" ? "mv" : "--exchange --no-copy";
    } else if (command === "mv") {
      expect(argv.slice(0, 4)).toEqual(["--exchange", "--no-copy", "-T", "--"]);
      fixture.beforeExchange?.();
      fixture.exchanges++;
      if (fixture.tools === "exchange-failed") {
        return { status: 1, stdout: "", stderr: "denied", pid: 0, output: [], signal: null };
      }
      const source = String(argv.at(-2));
      const target = String(argv.at(-1));
      const temporary = `${target}.test-exchange`;
      fs.renameSync(target, temporary);
      fs.renameSync(source, target);
      fs.renameSync(temporary, source);
      if (fixture.tools === "exchange-timeout") {
        status = 1;
      }
    } else if (nativeSpawnSync) {
      return nativeSpawnSync(command, args, options);
    } else {
      throw new Error(`unexpected command: ${command}`);
    }
    return { status, stdout, stderr: "", pid: 0, output: [], signal: null };
  });
  vi.spyOn(fs, "statfsSync").mockReturnValue({
    ...nativeStatfs(root, { bigint: true }),
    bavail: 1_000_000_000n,
    bsize: 4096n,
  });
  return fixture;
}
