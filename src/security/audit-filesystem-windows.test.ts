import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { collectSecurityAuditFindings } from "./audit.test-support.js";
import { AsyncTempCaseFactory } from "./test-temp-cases.js";

function windowsAclQueryResult(
  args: string[],
  stateGrant?: { sid: string; mask: number },
): { stdout: string; stderr: string } {
  const currentUserSid = "S-1-5-21-1-2-3-1001";
  const grants = [
    { sid: "S-1-5-18", mask: 0x001f_01ff },
    { sid: currentUserSid, mask: 0x001f_01ff },
  ];
  if (stateGrant && /(?:^|[\\/])state$/u.test(args[1] ?? "")) {
    grants.push(stateGrant);
  }
  return {
    stdout: JSON.stringify({
      ownerSid: currentUserSid,
      currentUserSid,
      daclPresent: true,
      aces: grants.map(({ sid, mask }) => ({ sid, mask, deny: false, inheritOnly: false })),
      complete: true,
      remote: false,
    }),
    stderr: "",
  };
}

const tempCases = new AsyncTempCaseFactory("openclaw-security-audit-win-");

beforeEach(() => {
  // The injected Windows helper fixture exercises the supported command fallback.
  vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
});
afterEach(() => vi.unstubAllEnvs());

beforeAll(() => tempCases.setup());
afterAll(() => tempCases.cleanup());

async function auditAcl(label: string, stateGrant?: { sid: string; mask: number }) {
  const stateDir = path.join(await tempCases.makeTmpDir(label), "state");
  await fs.mkdir(stateDir, { recursive: true });
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.writeFile(configPath, "{}\n", "utf-8");
  return collectSecurityAuditFindings(
    { agents: { entries: { main: {} } } },
    {
      stateDir,
      configPath,
      includeFilesystem: true,
      configSnapshot: null,
      platform: "win32",
      env: { USERNAME: "Tester", USERDOMAIN: "DESKTOP-TEST" },
      execIcacls: async (_cmd: string, args: string[]) => windowsAclQueryResult(args, stateGrant),
    },
  );
}

it("accepts owner-only Windows ACLs", async () => {
  expect(
    (await auditAcl("win")).filter(
      ({ checkId }) => checkId.startsWith("fs.") && checkId.includes(".perms_"),
    ),
  ).toEqual([]);
});

it.each([
  ["win-open", "S-1-5-32-545", 0x0012_00a9, "perms_readable", "warn"],
  ["win-anon-world", "S-1-5-7", 0x001f_01ff, "perms_world_writable", "critical"],
] as const)("reports unsafe ACLs: %s", async (label, sid, mask, suffix, severity) => {
  const findings = await auditAcl(label, { sid, mask });
  expect(findings).toContainEqual(
    expect.objectContaining({ checkId: `fs.state_dir.${suffix}`, severity }),
  );
  if (label === "win-anon-world") {
    expect(findings.some((f) => f.checkId === "fs.state_dir.perms_group_writable")).toBe(false);
  }
});
