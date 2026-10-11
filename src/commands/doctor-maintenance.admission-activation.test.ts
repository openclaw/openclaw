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

async function activate(admission: () => void, current: () => void = () => {}) {
  return withGatewayServiceUpdateAuthority(
    admission,
    async (assertCurrent) => {
      await activateSystemdServiceIdentity({
        identity,
        action: "restart",
        assertCurrent,
        warn: () => {},
      });
    },
    { updateOwned: false, assertRecoveryCurrent: current },
  );
}

it("restores within the native deadline when cold source observations cost two seconds", async () => {
  const { admission, family, assertIsolation } = fixture();
  const before = family();
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const observe = snapshots.readSqliteSourceContentVersionSync;
  vi.spyOn(snapshots, "readSqliteSourceContentVersionSync").mockImplementation((pathname) => {
    const version = observe(pathname);
    elapsed += 2_000;
    return version;
  });
  const prepare = snapshots.prepareSqliteReadOnlyLocationSync;
  vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync").mockImplementation((pathname) => {
    const prepared = prepare(pathname);
    // Deterministic slow-storage cost; the actual database read is not replaced.
    elapsed += 2_000;
    return prepared;
  });
  try {
    await activate(admission);
  } finally {
    expect(family()).toEqual(before);
    assertIsolation();
  }
  expect(native.effects).toEqual(["ResetFailedUnit", "RestartUnit"]);
  expect(native.closes).toBe(1);
});

it("refuses an update committed after the final restart ownership reply", async () => {
  const { env, admission, family, assertIsolation } = fixture();
  let committedFamily: unknown;
  native.preparingRestart = () => {
    createUpdateRun({ trigger: "cli", runId: "2c45c690-8265-498b-8504-d608ee2cda01" }, { env });
    committedFamily = family();
  };
  try {
    await expect(activate(admission)).rejects.toThrow("2c45c690-8265-498b-8504-d608ee2cda01");
    expect(family()).toEqual(committedFamily);
  } finally {
    assertIsolation();
  }
  expect(native.effects).toEqual(["ResetFailedUnit"]);
  expect(native.closes).toBe(1);
});

it("retains final native custody revocation after the final restart ownership reply", async () => {
  const { admission, assertIsolation } = fixture();
  let current = true;
  native.preparingRestart = () => {
    current = false;
  };
  try {
    await expect(
      activate(admission, () => {
        if (!current) {
          throw new Error("original native custody revoked");
        }
      }),
    ).rejects.toThrow("original native custody revoked");
  } finally {
    assertIsolation();
  }
  expect(native.effects).toEqual(["ResetFailedUnit"]);
  expect(native.closes).toBe(1);
});
