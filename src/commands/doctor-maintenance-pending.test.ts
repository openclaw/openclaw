import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { checkDoctorStateSchemaPending } from "../flows/doctor-health-startup.js";
import {
  closeDatabases,
  databaseFixture,
  supportedVersions,
} from "../state/database-preflight-fixtures.test-support.js";
import { traceDoctorMaintenancePending } from "./doctor-maintenance-pending.js";
import { checkDoctorLegacyStateDirPending } from "./doctor-maintenance-state.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeDatabases();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function capturePendingTrace() {
  vi.stubEnv("OPENCLAW_GATEWAY_STARTUP_TRACE", "1");
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  return () => lines.filter((line) => line.includes("doctor.pending."));
}

/** Every entry under root with its bytes and modification time. */
function snapshotTree(root: string): Array<[string, string, bigint]> {
  const entries: Array<[string, string, bigint]> = [];
  const visit = (pathname: string) => {
    const stat = fs.lstatSync(pathname, { bigint: true });
    const bytes = stat.isFile() ? fs.readFileSync(pathname).toString("base64") : "";
    entries.push([path.relative(root, pathname), bytes, stat.mtimeNs]);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(pathname).toSorted()) {
        visit(path.join(pathname, name));
      }
    }
  };
  visit(root);
  return entries;
}

describe("Doctor maintenance pending contract", () => {
  it("treats a step without a check as work and traces the default", async () => {
    const trace = capturePendingTrace();

    await expect(traceDoctorMaintenancePending("config-flow")).resolves.toBe(true);

    expect(trace()).toEqual([
      expect.stringMatching(/doctor\.pending\.config-flow .* pending=work check=default /u),
    ]);
  });

  it.each([
    ["none", false],
    ["work", true],
    ["undecidable", true],
  ] as const)("reports an owner answer of %s as work=%s", async (answer, work) => {
    const trace = capturePendingTrace();

    await expect(traceDoctorMaintenancePending("state-schema", () => answer)).resolves.toBe(work);

    expect(trace()).toEqual([
      expect.stringMatching(new RegExp(`pending=${answer} check=owner `, "u")),
    ]);
  });

  it("counts a failing check as undecidable work", async () => {
    const trace = capturePendingTrace();

    await expect(
      traceDoctorMaintenancePending("sqlite-nocow", async () => {
        throw new Error("probe failed");
      }),
    ).resolves.toBe(true);

    expect(trace()).toEqual([expect.stringMatching(/pending=undecidable check=owner /u)]);
  });
});

describe("legacy state directory check", () => {
  it("finds a pending move from path metadata without touching either root", async () => {
    const home = tempDirs.make("doctor-pending-legacy-");
    const legacy = path.join(home, ".clawdbot");
    fs.mkdirSync(path.join(legacy, "agents"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "clawdbot.json"), '{"gateway":{}}');
    const env = { HOME: home };
    const before = snapshotTree(home);

    await expect(checkDoctorLegacyStateDirPending(env)).resolves.toBe("work");
    expect(snapshotTree(home)).toEqual(before);

    fs.mkdirSync(path.join(home, ".openclaw"));
    const moved = snapshotTree(home);
    await expect(checkDoctorLegacyStateDirPending(env)).resolves.toBe("none");
    expect(snapshotTree(home)).toEqual(moved);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "cannot decide when the home cannot be inspected",
    async () => {
      const home = tempDirs.make("doctor-pending-legacy-unreadable-");
      fs.chmodSync(home, 0o000);
      try {
        const trace = capturePendingTrace();
        await expect(
          traceDoctorMaintenancePending("legacy-state-dir", () =>
            checkDoctorLegacyStateDirPending({ HOME: home }),
          ),
        ).resolves.toBe(true);
        expect(trace()).toEqual([expect.stringMatching(/pending=undecidable check=owner /u)]);
      } finally {
        fs.chmodSync(home, 0o700);
      }
    },
  );
});

describe("state schema check", () => {
  it("reads the prepared preflight and leaves the state database unchanged", async () => {
    const fixture = databaseFixture(tempDirs.make("doctor-pending-state-schema-"));
    fixture.state();
    closeDatabases();
    const before = snapshotTree(fixture.dir);

    expect(checkDoctorStateSchemaPending(await fixture.inspect({ scope: "state" }))).toBe("none");
    const newerRelease = await fixture.inspect({
      scope: "state",
      supportedVersions: { state: supportedVersions.state + 1, agent: supportedVersions.agent },
    });
    expect(checkDoctorStateSchemaPending(newerRelease)).toBe("work");

    expect(snapshotTree(fixture.dir)).toEqual(before);
  });
});
