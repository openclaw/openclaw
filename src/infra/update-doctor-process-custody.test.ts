import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { installPrivateUpdateHandoffStore } from "../../test/helpers/private-update-handoff-store.js";
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

it.each(["unavailable root", "missing bound database", "inaccessible command storage"] as const)(
  "permits no-child Doctor work with %s while refusing writer admission",
  async (failure) => {
    const root = fs.realpathSync(directories.make("doctor-unavailable-custody-"));
    const privateTmp = path.join(root, "private-tmp");
    fs.mkdirSync(privateTmp, { mode: 0o700 });
    const { databasePath } = installPrivateUpdateHandoffStore(privateTmp);
    const resultPath = path.join(root, "result.json");
    const receiptPath = `${resultPath}.processes`;
    const effect = path.join(root, "writer-effect");
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.stubEnv(UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV, resultPath);
    vi.spyOn(packageRoot, "resolveOpenClawPackageRoot").mockResolvedValue(
      failure === "unavailable root" ? null : root,
    );
    if (failure === "missing bound database") {
      fs.writeFileSync(
        receiptPath,
        JSON.stringify({
          nonce: "parent-custody",
          runId: "run",
          pid: 0,
          slots: [],
          namespace: {
            roots: [root],
            databaseIdentity: { databasePath, databaseIdentity: "1:2", parentIdentity: "1:3" },
          },
        }),
      );
    }
    const storageFailure = Object.assign(new Error("Command storage is inaccessible"), {
      code: "EACCES",
    });
    if (failure === "inaccessible command storage") {
      const mkdir = fs.mkdirSync;
      vi.spyOn(fs, "mkdirSync").mockImplementation((...args) => {
        if (String(args[0]) === privateTmp) {
          throw storageFailure;
        }
        return mkdir(...args);
      });
    }
    {
      using custody = await retainUpdateDoctorProcesses();
      expect(custody).toBeDefined();
      await expect(
        withCommandProcessScope(async () => "diagnostics completed", undefined, custody),
      ).resolves.toBe("diagnostics completed");
      const dispatch = withCommandProcessScope(
        async () =>
          await spawnCommand([
            process.execPath,
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(effect)}, 'written')`,
          ]),
        undefined,
        custody,
      );
      if (failure === "unavailable root") {
        await expect(dispatch).rejects.toThrow(
          "Doctor process custody requires its installation root",
        );
      } else if (failure === "missing bound database") {
        await expect(dispatch).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(dispatch).rejects.toBe(storageFailure);
      }
      expect(fs.existsSync(effect)).toBe(false);
      expect(JSON.parse(fs.readFileSync(receiptPath, "utf8"))).toMatchObject({ slots: [] });
    }
    expect(fs.existsSync(databasePath)).toBe(false);
    expect(fs.existsSync(receiptPath)).toBe(failure === "missing bound database");
  },
);

it.skipIf(process.platform === "win32").each(["reservation-before-ipc", "retired-before-ipc"])(
  "reconciles durable Doctor custody across %s without trusting the IPC namespace",
  async (cut) => {
    const root = directories.make("doctor-native-retirement-");
    const roots = [path.join(root, "original"), path.join(root, "candidate")];
    const resultPath = path.join(root, "doctor-result.json");
    const native = await nativeCustody.createManagedCommandProcessCustody({
      roots,
      runId: "run",
      databasePath: path.join(root, "handoffs.sqlite"),
    });
    const parent = await createUpdateDoctorProcessCustody("run", root, resultPath, {
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
    const doctorNative = await nativeCustody.createManagedCommandProcessCustody({
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

it.skipIf(process.platform === "win32")(
  "settles an exited Doctor's empty receipt while foreign live custody still blocks replacement",
  async () => {
    const root = directories.make("doctor-foreign-custody-");
    const roots = [root, path.join(root, "candidate")];
    const resultPath = path.join(root, "doctor-result.json");
    const peer = await nativeCustody.createManagedCommandProcessCustody({
      roots,
      runId: "doctor-b",
      databasePath: path.join(root, "handoffs.sqlite"),
    });
    const parent = await createUpdateDoctorProcessCustody("doctor-a", root, resultPath, {
      roots,
      databaseIdentity: peer.databaseIdentity,
    });
    const doctor = spawnSync(process.execPath, [
      "-e",
      "const fs = require('node:fs'); const file = process.argv[1]; " +
        "const receipt = JSON.parse(fs.readFileSync(file, 'utf8')); " +
        "receipt.pid = process.pid; fs.writeFileSync(file, JSON.stringify(receipt));",
      `${resultPath}.processes`,
    ]);
    expect(doctor.error).toBeUndefined();
    expect(doctor.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(`${resultPath}.processes`, "utf8"))).toMatchObject({
      pid: doctor.pid,
      slots: [],
    });
    const argv = [process.execPath, "-e", "process.stdin.resume()"];
    const reservation = peer.custody.reserve(argv);
    const writer = spawn(process.execPath, argv.slice(1), {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    const closed = once(writer, "close");
    const store = createManagedHandoffLeaseStore({
      databasePath: peer.databasePath,
      existingIdentity: peer.databaseIdentity,
      serviceManagerEnv: {},
    });
    try {
      await once(writer, "spawn");
      if (!writer.pid) {
        throw new Error("Missing peer command PID");
      }
      reservation.spawned({ pid: writer.pid, startedAt: null });
      const claims = store.readCommandChildren(roots);
      expect(claims).toHaveLength(roots.length);
      const settlement = await parent.settle({
        pid: doctor.pid,
        code: 0,
        cleanup: "normal",
        termination: "exit",
      });
      expect(settlement, settlement?.stderrTail ?? undefined).toMatchObject({
        exitCode: 0,
        diagnostics: [expect.stringContaining(`foreign custody, owned by Doctor ${process.pid}`)],
      });
      expect(settlement?.advisory).toBeUndefined();
      parent.close();
      expect(fs.existsSync(`${resultPath}.processes`)).toBe(false);
      expect(groups.isChildProcessTreeAlive({ pid: writer.pid })).toBe(true);
      expect(store.readCommandChildren(roots)).toEqual(claims);
      for (const installRoot of roots) {
        expect(store.acquire(installRoot, "replacement", { kind: "update" }).kind).toBe("busy");
      }
    } finally {
      writer.stdin?.end();
      await closed;
      reservation.settled();
      peer.releaseAnchors();
      parent.close();
    }
    for (const installRoot of roots) {
      const replacement = store.acquire(installRoot, "replacement", { kind: "update" });
      expect(replacement.kind).toBe("acquired");
      if (replacement.kind === "acquired") {
        expect(store.release(replacement.lease)).toBe(true);
      }
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
    const parent = await createUpdateDoctorProcessCustody(
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
