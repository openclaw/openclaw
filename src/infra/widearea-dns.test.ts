import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  getWideAreaZonePath,
  replaceWideAreaZoneFile,
  renderWideAreaGatewayZoneText as renderZone,
  resolveWideAreaDiscoveryDomain,
  type WideAreaGatewayZoneOpts,
  writeWideAreaGatewayZone as writeZone,
} from "./widearea-dns.js";

const replaceFileAtomicMock = vi.hoisted(() => vi.fn());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("@openclaw/fs-safe/atomic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/atomic")>()),
  replaceFileAtomic: replaceFileAtomicMock,
}));

const baseZoneOpts: WideAreaGatewayZoneOpts = {
  domain: "openclaw.internal.",
  gatewayPort: 18789,
  displayName: "Mac Studio (OpenClaw)",
  tailnetIPv4: "100.123.224.76",
};
const zonePath = getWideAreaZonePath(baseZoneOpts.domain);

function renderZoneText(overrides: Partial<WideAreaGatewayZoneOpts> = {}): string {
  return renderZone({ ...baseZoneOpts, ...overrides, serial: 2025121701 });
}
async function expectZoneWrite(changed: boolean, overrides: Partial<WideAreaGatewayZoneOpts> = {}) {
  expect(await writeZone({ ...baseZoneOpts, ...overrides })).toEqual({ zonePath, changed });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  replaceFileAtomicMock.mockReset();
});

it("returns null for invalid env domains", () => {
  vi.stubEnv("OPENCLAW_WIDE_AREA_DOMAIN", "foo/bar");
  expect(resolveWideAreaDiscoveryDomain()).toBeNull();
});

it("renders gateway DNS-SD records", () => {
  vi.spyOn(os, "hostname").mockReturnValue("Studio London");
  const txt = renderZoneText({
    domain: "openclaw.internal",
    displayName: "  Mac Studio (OpenClaw)  ",
    tailnetIPv6: "fd7a:115c:a1e0::8801:e04c",
    sshPort: 22,
    cliPath: " /opt/homebrew/bin/openclaw ",
    gatewayTlsEnabled: true,
    gatewayTlsFingerprintSha256: "abc123",
    gatewayDirectReachable: true,
    tailnetDns: " tailnet.ts.net ",
  });
  for (const record of [
    `$ORIGIN openclaw.internal.`,
    `studio-london IN A 100.123.224.76`,
    `studio-london IN AAAA fd7a:115c:a1e0::8801:e04c`,
    `_openclaw-gw._tcp IN PTR studio-london-gateway._openclaw-gw._tcp`,
    `studio-london-gateway._openclaw-gw._tcp IN SRV 0 0 18789 studio-london`,
    `displayName=Mac Studio (OpenClaw)`,
    `gatewayPort=18789`,
    `sshPort=22`,
    `cliPath=/opt/homebrew/bin/openclaw`,
    `studio-london-gateway._openclaw-gw._tcp IN TXT`,
    `gatewayTls=1`,
    `gatewayTlsSha256=abc123`,
    `gatewayDirectReachable=1`,
    `tailnetDns=tailnet.ts.net`,
  ]) {
    expect(txt).toContain(record);
  }
});

it("drops a trailing hyphen when a host label is cut to 63 characters", () => {
  vi.spyOn(os, "hostname").mockReturnValue(`${"a".repeat(62)}-${"b".repeat(20)}`);
  const txt = renderZoneText();
  const hostLine = txt.split("\n").find((line) => line.startsWith("a"));
  expect(hostLine).toBe(`${"a".repeat(62)} IN A 100.123.224.76`);
});

it.each(["EACCES", "EIO"])("preserves the zone on %s", async (code) => {
  const error = Object.assign(new Error("cannot read existing zone"), { code });
  vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
    throw error;
  });
  await expect(writeZone(baseZoneOpts)).rejects.toBe(error);
  expect(replaceFileAtomicMock).not.toHaveBeenCalled();
});

it("creates the zone when no previous file exists", async () => {
  vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
    throw Object.assign(new Error("missing zone"), { code: "ENOENT" });
  });
  await expectZoneWrite(true);
  expect(replaceFileAtomicMock).toHaveBeenCalledOnce();
  expect(replaceFileAtomicMock).toHaveBeenCalledWith({
    filePath: zonePath,
    content: expect.any(String),
    dirMode: 0o700,
    mode: 0o644,
    preserveExistingMode: true,
    syncTempFile: true,
    syncParentDir: true,
    tempPrefix: ".openclaw-dns-zone",
  });
});

it.each([
  ["   ", "wide-area discovery domain is required"],
  ["../../x", "wide-area discovery domain must be a valid DNS name"],
])("rejects domain %j before writing", async (domain, message) => {
  await expect(writeZone({ ...baseZoneOpts, domain })).rejects.toThrow(message);
  expect(replaceFileAtomicMock).not.toHaveBeenCalled();
});

it("skips rewriting unchanged content", async () => {
  const existing = renderZone({ ...baseZoneOpts, serial: 2026031301 });
  vi.spyOn(fs, "readFileSync").mockReturnValue(existing);
  await expectZoneWrite(false);
  expect(replaceFileAtomicMock).not.toHaveBeenCalled();
});

it("publishes a complete zone without synchronously flushing the main thread", async () => {
  const directory = tempDirs.make("openclaw-widearea-dns-async-");
  const target = path.join(directory, "zone.db");
  const next = "; replacement zone\n$ORIGIN openclaw.internal.\n";
  fs.writeFileSync(target, "; previous zone\n", { mode: 0o640 });
  const atomic = await vi.importActual<typeof import("@openclaw/fs-safe/atomic")>(
    "@openclaw/fs-safe/atomic",
  );
  replaceFileAtomicMock.mockImplementationOnce(atomic.replaceFileAtomic);
  using sync = vi.spyOn(fs, "fsyncSync");
  await replaceWideAreaZoneFile(target, next);
  expect(fs.readFileSync(target, "utf8")).toBe(next);
  if (process.platform !== "win32") {
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
  }
  expect(fs.readdirSync(directory)).toEqual(["zone.db"]);
  expect(sync).not.toHaveBeenCalled();
});

it.runIf(process.platform !== "win32")("preserves the zone after an OS file-size failure", () => {
  const stateDir = tempDirs.make("openclaw-widearea-dns-fault-");
  const dnsDir = path.join(stateDir, "dns");
  const faultZonePath = path.join(dnsDir, "openclaw.internal.db");
  const previous = "; previous valid zone\n$ORIGIN openclaw.internal.\n";
  fs.mkdirSync(dnsDir);
  fs.writeFileSync(faultZonePath, previous, { mode: 0o640 });

  const moduleUrl = pathToFileURL(path.resolve("src/infra/widearea-dns.ts")).href;
  const script = `
          const { writeWideAreaGatewayZone } = await import(${JSON.stringify(moduleUrl)});
          try {
            await writeWideAreaGatewayZone({
              domain: "openclaw.internal",
              gatewayPort: 18789,
              displayName: "X".repeat(8192),
              tailnetIPv4: "100.64.0.1",
            });
            process.exitCode = 24;
          } catch (error) {
            if (error?.code !== "EFBIG") {
              console.error(error);
              process.exitCode = 25;
            }
          }
        `;
  const child = spawnSync(
    "/bin/sh",
    [
      "-c",
      'ulimit -f 1; exec "$@"',
      "openclaw-widearea-dns-fault",
      process.execPath,
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      script,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    },
  );

  expect(child.status, child.stderr).toBe(0);
  expect(fs.readFileSync(faultZonePath, "utf8")).toBe(previous);
  expect(fs.statSync(faultZonePath).mode & 0o777).toBe(0o640);
  expect(fs.readdirSync(dnsDir)).toEqual(["openclaw.internal.db"]);
});
