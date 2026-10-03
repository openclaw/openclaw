import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as groups from "../process/child-process-tree.js";
import { spawnCommand, withCommandProcessScope } from "../process/exec-spawn.js";
import * as packageRoot from "./openclaw-root.js";
import {
  createUpdateDoctorProcessCustody,
  retainUpdateDoctorProcesses,
} from "./update-doctor-process-custody.js";
import { UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV } from "./update-doctor-result.js";
import * as nativeCustody from "./update-managed-command-custody.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("permits no-child Doctor work without an installation root while refusing writer admission", async () => {
  const root = directories.make("doctor-unresolved-root-");
  const resultPath = path.join(root, "result.json");
  const effect = path.join(root, "writer-effect");
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.stubEnv(UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV, resultPath);
  vi.spyOn(packageRoot, "resolveOpenClawPackageRoot").mockResolvedValue(null);
  using custody = await retainUpdateDoctorProcesses();
  expect(custody).toBeDefined();
  await expect(
    withCommandProcessScope(
      async () =>
        await spawnCommand([
          process.execPath,
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(effect)}, 'written')`,
        ]),
      undefined,
      custody,
    ),
  ).rejects.toThrow("Doctor process custody requires its installation root");
  expect(fs.existsSync(effect)).toBe(false);
});

it.skipIf(process.platform === "win32").each(["reservation-before-ipc", "retired-before-ipc"])(
  "reconciles durable Doctor custody across %s without trusting the IPC namespace",
  async (cut) => {
    const root = directories.make("doctor-native-retirement-");
    const roots = [path.join(root, "original"), path.join(root, "candidate")];
    const resultPath = path.join(root, "doctor-result.json");
    const native = nativeCustody.createManagedCommandProcessCustody({
      roots,
      runId: "run",
      databasePath: path.join(root, "handoffs.sqlite"),
    });
    const parent = createUpdateDoctorProcessCustody("run", root, resultPath, {
      roots,
      databaseIdentity: native.databaseIdentity,
    });
    const receipt: Record<string, unknown> = JSON.parse(
      fs.readFileSync(`${resultPath}.processes`, "utf8"),
    );
    const nonce = receipt.nonce;
    if (typeof nonce !== "string") {
      throw new Error("Doctor custody nonce is unavailable");
    }
    fs.writeFileSync(
      `${resultPath}.processes`,
      JSON.stringify({
        ...receipt,
        pid: process.pid,
        namespace: {
          roots: [path.join(root, "unrelated")],
          databaseIdentity: native.databaseIdentity,
        },
        slots:
          cut === "retired-before-ipc" ? [{ id: 1, identity: { pid: 4242, startedAt: 1 } }] : [],
      }),
    );
    const doctorNative = nativeCustody.createManagedCommandProcessCustody({
      roots,
      runId: "run",
      databaseIdentity: native.databaseIdentity,
      anchorOwner: `doctor:${nonce}`,
    });
    const reservation =
      cut === "reservation-before-ipc"
        ? doctorNative.custody.reserve([process.execPath])
        : undefined;
    const store = createManagedHandoffLeaseStore({
      databasePath: native.databasePath,
      existingIdentity: native.databaseIdentity,
      serviceManagerEnv: {},
    });
    vi.spyOn(groups, "isChildProcessTreeAlive").mockReturnValue(false);
    try {
      const settlement = await parent.settle({
        pid: process.pid,
        code: 124,
        cleanup: "forced",
        termination: "timeout",
      });
      expect(settlement).toMatchObject({ exitCode: reservation ? 1 : 0 });
      if (reservation) {
        expect(settlement?.failureFacts).toContainEqual(
          expect.objectContaining({
            code: "doctor-processes-unsettled",
            message: expect.stringContaining("reservation"),
          }),
        );
        expect(store.readCommandChildren(roots)).toHaveLength(roots.length);
        for (const installRoot of roots) {
          expect(store.read(installRoot)).toMatchObject({
            kind: "current",
            lease: { owner: `doctor:${nonce}` },
          });
        }
      } else {
        expect(store.readCommandChildren(roots)).toEqual([]);
      }
      parent.close();
      expect(fs.existsSync(`${resultPath}.processes`)).toBe(Boolean(reservation));
    } finally {
      reservation?.settled();
      doctorNative.releaseAnchors();
    }
  },
);

it.each([
  {
    name: "normal completion",
    interrupted: false,
    delegated: false,
    inputReleased: undefined,
    running: false,
    blocked: false,
  },
  {
    name: "unknown interruption",
    interrupted: true,
    delegated: false,
    inputReleased: undefined,
    running: false,
    blocked: true,
  },
  {
    name: "withheld private grant",
    interrupted: true,
    delegated: true,
    inputReleased: false,
    running: false,
    blocked: false,
  },
  {
    name: "released private grant",
    interrupted: true,
    delegated: true,
    inputReleased: true,
    running: false,
    blocked: true,
  },
  {
    name: "standalone withheld input",
    interrupted: true,
    delegated: false,
    inputReleased: false,
    running: false,
    blocked: true,
  },
  {
    name: "running private child",
    interrupted: true,
    delegated: true,
    inputReleased: false,
    running: true,
    blocked: true,
  },
])(
  "preserves Windows Doctor writer custody for $name",
  async ({ interrupted, delegated, inputReleased, running, blocked }) => {
    const root = directories.make("doctor-windows-custody-");
    const resultPath = path.join(root, "result.json");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv(UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV, resultPath);
    vi.spyOn(groups, "isChildProcessTreeAlive").mockReturnValue(running);
    vi.spyOn(nativeCustody, "createManagedCommandProcessCustody").mockImplementation(() => {
      throw new Error("Windows command groups have no extinction receipt");
    });
    const parent = createUpdateDoctorProcessCustody(
      "run",
      root,
      resultPath,
      undefined,
      delegated ? "delegated-doctor" : undefined,
    );
    expect(await retainUpdateDoctorProcesses()).toBeUndefined();
    const settlement = await parent.settle({
      pid: 4242,
      code: interrupted ? null : 0,
      cleanup: interrupted ? "forced" : "normal",
      termination: interrupted ? "timeout" : "exit",
      inputReleased,
    });
    if (blocked) {
      expect(settlement).toMatchObject({
        exitCode: 1,
        failureFacts: [
          expect.objectContaining({
            code: "doctor-processes-unsettled",
            message: expect.stringContaining("4242"),
          }),
        ],
      });
    } else {
      expect(settlement).toBeUndefined();
    }
    parent.close();
    expect(fs.existsSync(`${resultPath}.processes`)).toBe(blocked);
  },
);
