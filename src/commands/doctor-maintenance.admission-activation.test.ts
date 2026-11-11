import { afterEach, expect, it, vi } from "vitest";
import type { SystemdServiceIdentity } from "../daemon/service-types.js";
import { withGatewayServiceUpdateAuthority } from "../daemon/service-update-authority.js";
import { activateSystemdServiceIdentity } from "../daemon/systemd-service-identity.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { setupDoctorAdmissionFixture } from "./doctor-maintenance.admission.test-support.js";

const native = vi.hoisted(() => ({
  effects: [] as string[],
  preparingRestart: undefined as (() => void) | undefined,
  closes: 0,
  ownerReads: 0,
}));

// Only the external systemd transport is synthetic. OpenClaw's queue, deadlines,
// identity checks, service authority, and every Doctor ledger read remain real.
vi.mock("@openclaw/proc-safe/systemd", () => ({
  SystemdBus: {
    connectBroker: async () => ({
      close: async () => {
        native.closes++;
      },
      call: async ({ member }: { member: string }) => {
        const values: Record<string, string | number | undefined> = {
          GetId: "0123456789abcdef0123456789abcdef",
          GetNameOwner: ":1.42",
          GetConnectionUnixUser: 2001,
          LoadUnit: "/org/freedesktop/systemd1/unit/openclaw_2eservice",
          RestartUnit: "/org/freedesktop/systemd1/job/7",
          ResetFailedUnit: undefined,
        };
        if (!Object.hasOwn(values, member)) {
          throw new Error(`Unexpected method ${member}`);
        }
        // The last awaited ownership response precedes the next effect's submission.
        if (member === "GetNameOwner" && ++native.ownerReads === 4) {
          native.preparingRestart?.();
        }
        if (member === "ResetFailedUnit" || member === "RestartUnit") {
          native.effects.push(member);
        }
        return values[member] === undefined ? [] : [values[member]];
      },
      getProperty: async ({ member }: { member: string }) => {
        const values: Record<string, string> = {
          Id: "openclaw.service",
          FragmentPath: "/synthetic-doctor/openclaw.service",
          User: "",
        };
        if (!Object.hasOwn(values, member)) {
          throw new Error(`Unexpected property ${member}`);
        }
        return values[member];
      },
    }),
  },
}));

const fixture = setupDoctorAdmissionFixture();
afterEach(() => {
  native.effects = [];
  native.preparingRestart = undefined;
  native.closes = 0;
  native.ownerReads = 0;
});

const identity: SystemdServiceIdentity = {
  scope: "user",
  unitName: "openclaw.service",
  unitPath: "/synthetic-doctor/openclaw.service",
  bus: { address: "unix:path=/synthetic-doctor/bus" },
  busId: "0123456789abcdef0123456789abcdef",
  managerOwner: ":1.42",
  managerUid: 2001,
  serviceUser: "",
};

function activate(admission: () => void, current: () => void = () => {}) {
  return withGatewayServiceUpdateAuthority(
    admission,
    (assertCurrent) =>
      activateSystemdServiceIdentity({
        identity,
        action: "restart",
        assertCurrent,
        warn: () => {},
      }),
    { updateOwned: false, assertRecoveryCurrent: current },
  );
}

it("restores within the native deadline when cold source observations cost two seconds", async () => {
  using context = fixture();
  const { admission, family } = context;
  const before = family();
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const slow =
    <T>(read: (pathname: string) => T) =>
    (pathname: string) => {
      const result = read(pathname);
      elapsed += 2_000;
      return result;
    };
  const observe = snapshots.readSqliteSourceContentVersionSync;
  const prepare = snapshots.prepareSqliteReadOnlyLocationSync;
  vi.spyOn(snapshots, "readSqliteSourceContentVersionSync").mockImplementation(slow(observe));
  vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync").mockImplementation(slow(prepare));
  await activate(admission);
  expect(family()).toEqual(before);
  expect([native.effects, native.closes]).toEqual([["ResetFailedUnit", "RestartUnit"], 1]);
});

it.each(["new update", "revoked custody"] as const)(
  "refuses %s after the final restart ownership reply",
  async (reason) => {
    using context = fixture();
    const { env, admission, family } = context;
    const runId = "2c45c690-8265-498b-8504-d608ee2cda01";
    const message = reason === "new update" ? runId : "original native custody revoked";
    let current = true;
    let committedFamily: unknown;
    native.preparingRestart = () => {
      if (reason === "new update") {
        createUpdateRun({ trigger: "cli", runId }, { env });
        committedFamily = family();
      } else {
        current = false;
      }
    };
    await expect(
      activate(admission, () => {
        if (!current) {
          throw new Error(message);
        }
      }),
    ).rejects.toThrow(message);
    if (reason === "new update") {
      expect(family()).toEqual(committedFamily);
    }
    expect([native.effects, native.closes]).toEqual([["ResetFailedUnit"], 1]);
  },
);
