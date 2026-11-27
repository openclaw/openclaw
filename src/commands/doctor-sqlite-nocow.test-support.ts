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
    noCowInodes: new Set<number>(),
    exchanges: 0,
    acls: new Map<string, string>(),
    unavailableAclTool: undefined as "getfacl" | "setfacl" | undefined,
    rejectAclVerification: false,
    beforeExchange: undefined as (() => void) | undefined,
    fuserResult: undefined as SpawnSyncReturns<string> | undefined,
  };
  function permissions(bits: number): string {
    return `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${bits & 1 ? "x" : "-"}`;
  }

  function modeFromAcl(acl: string): number {
    const entries = acl.split("\n");
    const entryBits = (tag: string) => {
      const value = entries.find((line) => line.startsWith(`${tag}::`))?.split(":")[2] ?? "---";
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
      .replace(/(^|\n)user::[^\n]*/g, `$1user::${owner}`)
      .replace(/(^|\n)mask::[^\n]*/g, `$1mask::${group}`)
      .replace(/(^|\n)group::[^\n]*/g, masked ? "$&" : `$1group::${group}`)
      .replace(/(^|\n)other::[^\n]*/g, `$1other::${other}`);
  }

  vi.mocked(isSqlitePathOnBtrfs).mockReturnValue(true);
  vi.mocked(setSqliteDirectoryNoCow).mockImplementation((dir) => {
    const stat = fs.statSync(dir);
    expect(stat.isDirectory()).toBe(true);
    fixture.noCowInodes.add(stat.ino);
  });
  vi.mocked(spawnSync).mockImplementation((command, args, options) => {
    const argv = args ?? [];
    let stdout = "";
    let status = 0;
    if (command === "lsattr") {
      const pathname = String(argv.at(-1));
      const ino = fs.statSync(pathname).ino;
      if (pathname.includes(".nocow-backup-")) {
        fixture.noCowInodes.add(ino);
      }
      stdout = `${fixture.attributes || fixture.noCowInodes.has(ino) ? "-------C------" : "--------------"} ${pathname}`;
      status = fixture.tools === "unavailable" ? 127 : 0;
    } else if (command === "getfacl" || command === "setfacl") {
      expect(options?.env?.POSIXLY_CORRECT).toBeUndefined();
      if (fixture.unavailableAclTool === command) {
        status = 127;
      } else if (command === "getfacl") {
        expect(argv.slice(0, 2)).toEqual(["-cEpn", "--"]);
        stdout = argv.slice(2).map(observedAcl).join("\n\n");
      } else {
        expect(argv).toEqual(["--restore=-"]);
        if (typeof options?.input !== "string") {
          throw new Error("Expected textual ACL input");
        }
        for (const block of options.input.trim().split("\n\n")) {
          const [header, ...lines] = block.split("\n");
          const pathname = header!
            .slice("# file: ".length)
            .replaceAll("\\012", "\n")
            .replaceAll("\\134", "\\");
          const acl = fixture.rejectAclVerification ? baseAcl : lines.join("\n");
          fixture.acls.set(pathname, acl);
          fs.chmodSync(pathname, (fs.statSync(pathname).mode & 0o7000) | modeFromAcl(acl));
        }
      }
    } else if (command === "fuser" && argv[0]?.includes(".nocow-probe-") && !nativeSpawnSync) {
      status = 0;
      stdout = String(process.pid);
    } else if (command === "fuser" && fixture.fuserResult) {
      return fixture.fuserResult;
    } else if (command === "fuser" && !nativeSpawnSync) {
      expect(argv.length).toBeGreaterThan(0);
      expect(argv.every((argument) => path.isAbsolute(argument))).toBe(true);
      status = fixture.tools === "busy" ? 0 : 1;
      stdout = fixture.tools === "busy" ? "12345" : "";
    } else if (command === "mv") {
      expect(argv.slice(0, 4)).toEqual(["--exchange", "--no-copy", "-T", "--"]);
      const preflight = String(argv.at(-2)).includes(".nocow-probe-");
      if (!preflight) {
        fixture.beforeExchange?.();
        fixture.exchanges++;
      }
      if (fixture.tools === "unavailable" || (!preflight && fixture.tools === "exchange-failed")) {
        return { status: 1, stdout: "", stderr: "denied", pid: 0, output: [], signal: null };
      }
      const source = String(argv.at(-2));
      const target = String(argv.at(-1));
      const temporary = `${target}.test-exchange`;
      fs.renameSync(target, temporary);
      fs.renameSync(source, target);
      fs.renameSync(temporary, source);
      status = !preflight && fixture.tools === "exchange-timeout" ? 1 : 0;
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
