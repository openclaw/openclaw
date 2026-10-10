import { afterEach, expect, it, vi } from "vitest";
import type { SystemdServiceIdentity } from "../daemon/service-types.js";
import { withGatewayServiceUpdateAuthority } from "../daemon/service-update-authority.js";
import { activateSystemdServiceIdentity } from "../daemon/systemd-service-identity.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { setupDoctorAdmissionFixture } from "./doctor-maintenance.admission.test-support.js";

const native = vi.hoisted(() => ({
  decoded: new WeakMap<object, unknown>(),
  effects: [] as string[],
  preparingRestart: undefined as (() => void) | undefined,
  closes: 0,
}));

// Only the external sd-bus ABI is synthetic. Native queueing, deadlines, identity
// checks, nested service authority, and every Doctor ledger read remain real.
vi.mock("node:module", async (importOriginal) => {
  const { mockNodeBuiltinModule } =
    await import("../plugin-sdk/test-helpers/node-builtin-mocks.js");
  const original = await importOriginal<typeof import("node:module")>();
  return mockNodeBuiltinModule(() => Promise.resolve(original), {
    createRequire: (filename: string | URL) => {
      const require = original.createRequire(filename);
      return Object.assign(
        (specifier: string) =>
          specifier !== "koffi"
            ? require(specifier)
            : {
                sizeof: () => 24,
                struct: () => ({}),
                decode: (buffer: object) => native.decoded.get(buffer),
                load: () => ({
                  func: (declaration: string) => {
                    const name = declaration.match(/\b(sd_bus_[a-z_]+)\(/)?.[1];
                    const call = (...args: unknown[]) => {
                      if (name === "sd_bus_new") {
                        (args[0] as unknown[])[0] = {};
                      } else if (name === "sd_bus_message_new_method_call") {
                        (args[1] as unknown[])[0] = { member: args[5] };
                        if (args[5] === "RestartUnit") {
                          native.preparingRestart?.();
                        }
                      } else if (name === "sd_bus_call") {
                        const member = (args[1] as { member: string }).member;
                        const values: Record<string, unknown> = {
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
                        if (member === "ResetFailedUnit" || member === "RestartUnit") {
                          native.effects.push(member);
                        }
                        (args[4] as unknown[])[0] = { value: values[member] };
                      } else if (name === "sd_bus_get_property") {
                        const values: Record<string, string> = {
                          Id: "openclaw.service",
                          FragmentPath: "/synthetic-doctor/openclaw.service",
                          User: "",
                        };
                        const member = args[4] as string;
                        if (!Object.hasOwn(values, member)) {
                          throw new Error(`Unexpected property ${member}`);
                        }
                        (args[6] as unknown[])[0] = { value: values[member] };
                      } else if (name === "sd_bus_message_read_basic") {
                        native.decoded.set(
                          args[2] as object,
                          (args[0] as { value: unknown }).value,
                        );
                        return 1;
                      } else if (name === "sd_bus_close_unref") {
                        native.closes++;
                      }
                      return name === "sd_bus_is_ready" || name === "sd_bus_message_at_end" ? 1 : 0;
                    };
                    return Object.assign(call, {
                      async: (...args: unknown[]) => {
                        const complete = args.pop() as (error: unknown, result?: number) => void;
                        try {
                          complete(null, call(...args));
                        } catch (error) {
                          complete(error);
                        }
                      },
                    });
                  },
                }),
              },
        require,
      );
    },
  });
});

const fixture = setupDoctorAdmissionFixture();
afterEach(() => {
  native.effects = [];
  native.preparingRestart = undefined;
  native.closes = 0;
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

it("restores within the native deadline when each fresh private snapshot costs two seconds", async () => {
  const { admission, family, assertIsolation } = fixture();
  const before = family();
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
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

it("refuses an update committed after native restart message preparation", async () => {
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

it("retains final native custody revocation after restart message preparation", async () => {
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
