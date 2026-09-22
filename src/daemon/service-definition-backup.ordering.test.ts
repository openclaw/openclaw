import "./service-definition-backup.mocks.test-support.js";
import fs from "node:fs/promises";
import { PassThrough } from "node:stream";
import { DOMParser } from "linkedom";
import { expect, it, vi } from "vitest";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import * as pidAlive from "../shared/pid-alive.js";
import { installLaunchAgent } from "./launchd-install.js";
import { restoreGatewayServiceDefinitionBackup } from "./service-definition-backup.js";
import { fixture, native, readRetainedReceipt } from "./service-definition-backup.test-support.js";
import { withGatewayServiceOperationLock } from "./service-operation-lock.js";
import {
  captureGatewayServiceRebind,
  currentGatewayServiceRebindReceipt,
  fingerprintGatewayServiceDefinition,
  withGatewayServiceRebindCapture,
} from "./service-rebind.js";
import { reconcileGatewayServiceDefinition } from "./service-reconciliation.js";
import { readServiceFileState } from "./service-stage.js";
import {
  assertGatewayServiceUpdateCurrent,
  GatewayServiceAuthorityError,
  withGatewayServiceUpdateAuthority,
} from "./service-update-authority.js";
import { stageSystemdService } from "./systemd-install.js";
import * as systemdScope from "./systemd-scope.js";

vi.mock("./service-audit.js", () => ({
  auditGatewayServiceConfig: async () => ({ issues: [], definitionDrift: [] }),
}));
vi.mock("./service-layout.js", async (original) => ({
  ...(await original<typeof import("./service-layout.js")>()),
  gatewayServiceCommandMatchesRoot: async () => true,
}));

function taskReference(xml: string): string {
  return new DOMParser().parseFromString(xml, "text/xml").querySelector("Exec > Command")!
    .textContent;
}

it.each([
  "before-create",
  "create-failed",
  "after-create",
  "unverified-create",
  "after-delete",
  "normal",
])("keeps the registered task runnable while retiring a new VBS launcher: %s", async (fault) => {
  const f = await fixture("win32");
  const launcher = f.files[1]!;
  const referenced = () => taskReference(f.task());
  await f.install();
  expect(referenced()).toBe(launcher);
  await fs.access(referenced());
  const receipt = await f.capture.finish();
  const execute = native.task.getMockImplementation()!;
  native.task.mockImplementation(async (args: string[]) => {
    if (args[0] === "/Create" && fault === "before-create") {
      throw new Error("interrupted task restoration");
    }
    if (args[0] === "/Create" && fault === "create-failed") {
      return { code: 1, stdout: "", stderr: "injected create failure" };
    }
    const result = await execute(args);
    if (args[0] === "/Create" && fault === "after-create") {
      throw new Error("interrupted task restoration");
    }
    if (args[0] === "/Create" && fault === "unverified-create") {
      f.setTask(f.task().replace("<Count>0</Count>", "<Count>7</Count>"));
    }
    return result;
  });
  const unlink = fs.unlink.bind(fs);
  const retire = vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
    if (file === launcher && fault === "normal") {
      expect(f.task()).toBe(f.originalTask);
      await fs.access(referenced());
    }
    await unlink(file);
    if (file === launcher && fault === "after-delete") {
      throw new Error("interrupted launcher retirement");
    }
  });
  const restore = () => restoreGatewayServiceDefinitionBackup({ ...f, receipt });
  if (fault === "normal") {
    await restore();
  } else {
    const error = await restore().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    await fs.access(referenced());
    if (fault !== "after-delete") {
      await fs.access(launcher);
      expect(String(error)).toContain(launcher);
      expect(String(error)).toContain("Restore and verify");
    }
    retire.mockRestore();
    native.task.mockImplementation(execute);
    const retained = await readRetainedReceipt(f.capture.backupPaths);
    if (fault === "unverified-create") {
      await expect(
        restoreGatewayServiceDefinitionBackup({ ...f, receipt: retained }),
      ).rejects.toThrow("Scheduled Task changed");
      await fs.access(launcher);
      return;
    }
    await restoreGatewayServiceDefinitionBackup({ ...f, receipt: retained });
  }
  expect(f.task()).toBe(f.originalTask);
  expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
  await fs.access(referenced());
  await expect(fs.stat(launcher)).rejects.toMatchObject({ code: "ENOENT" });
});

it("warns with the retained launcher and recovery step when compensation cannot restore task XML", async () => {
  const f = await fixture("win32");
  const warnings: string[] = [];
  const execute = native.task.getMockImplementation()!;
  let creates = 0;
  native.task.mockImplementation(async (args: string[]) => {
    if (args[0] === "/Create" && ++creates === 2) {
      return { code: 1, stdout: "", stderr: "injected restore failure" };
    }
    return execute(args);
  });
  await expect(
    reconcileGatewayServiceDefinition({
      env: f.env,
      root: "/old",
      command: f.command,
      expectedCommand: f.command,
      install: async (hooks) => {
        await f.install(hooks);
        throw new Error("injected activation failure");
      },
      warn: (message) => warnings.push(message),
    }),
  ).rejects.toThrow("UPDATE_NATIVE_AUTHORITY");
  expect(
    warnings.some(
      (message) => message.includes(f.files[1]!) && message.includes("Restore and verify"),
    ),
  ).toBe(true);
  await fs.access(taskReference(f.task()));
  await fs.access(f.files[1]!);
});

it.each([
  { fault: "checkpoint", receipt: true },
  { fault: "ownership", receipt: true },
  { fault: "ownership", receipt: false },
])(
  "keeps the systemd environment referenced after $fault failure (receipt=$receipt)",
  async ({ fault, receipt }) => {
    const f = await fixture("linux");
    const environmentPath = f.files[1]!;
    const rename = fs.rename.bind(fs);
    let published = false;
    const publication = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (destination === f.sourcePath && published) {
        throw new Error("injected unit restoration failure");
      }
      await rename(source, destination);
      if (destination === f.sourcePath) {
        published = true;
      }
    });
    const ownership = vi
      .spyOn(systemdScope, "assertNoSystemGatewayOwnership")
      .mockImplementation(async () => {
        if (fault === "ownership" && published) {
          throw new Error("injected ownership inspection failure");
        }
      });
    await expect(
      stageSystemdService({
        env: f.env,
        stdout: new PassThrough(),
        programArguments: ["/usr/bin/node", "/new/index.js", "gateway"],
        environment: { ...f.command.environment, OPERATOR_SETTING: "candidate" },
        environmentValueSources: { OPERATOR_SETTING: "file" },
        definitionTransaction: receipt
          ? {
              ...f.capture.hooks,
              fileWritten: async (file, contents) => {
                await f.capture.hooks.fileWritten(file, contents);
                if (file === f.sourcePath && fault === "checkpoint") {
                  throw new Error("injected checkpoint failure");
                }
              },
            }
          : undefined,
      }),
    ).rejects.toThrow("injected");
    const candidate = await fs.readFile(f.sourcePath);
    expect(candidate.toString()).toContain(environmentPath);
    expect(await fs.readFile(environmentPath, "utf8")).toContain("candidate");
    if (!receipt) {
      return;
    }

    ownership.mockRestore();
    await expect(f.capture.compensate()).rejects.toThrow("injected unit restoration failure");
    expect(await fs.readFile(f.sourcePath)).toEqual(candidate);
    await fs.access(environmentPath);
    publication.mockRestore();
    await f.capture.compensate();
    expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
    await expect(fs.access(environmentPath)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.each(["publication", "activation"])(
  "leaves LaunchAgent inputs and references together for receipt compensation after %s failure",
  async (fault) => {
    const f = await fixture("darwin");
    let candidate: Buffer | undefined;
    let loaded = false;
    // Fixture bootout ends PID 42 with its job; never consult the host process table.
    vi.spyOn(pidAlive, "isPidDefinitelyDead").mockImplementation((pid) => pid === 42 && !loaded);
    native.launchctl.mockImplementation(async (args) => {
      if (args[0] === "bootstrap") {
        loaded = true;
        throw new Error("injected activation failure");
      }
      if (args[0] === "bootout") {
        loaded = false;
      }
      if (args[0] !== "print" || loaded) {
        return { code: 0, stdout: "state = running\npid = 42", stderr: "", termination: "exit" };
      }
      return { code: 113, stdout: "", stderr: "Could not find service", termination: "exit" };
    });
    await expect(
      installLaunchAgent({
        env: f.env,
        stdout: new PassThrough(),
        programArguments: ["/usr/bin/node", "/new/index.js", "gateway"],
        environment: f.command.environment,
        definitionTransaction: {
          ...f.capture.hooks,
          fileWritten: async (file, contents) => {
            await f.capture.hooks.fileWritten(file, contents);
            if (file === f.sourcePath && !candidate) {
              candidate = await fs.readFile(file);
              if (fault === "publication") {
                throw new Error("injected publication failure");
              }
            }
          },
        },
      }),
    ).rejects.toThrow("injected");
    expect(candidate).toBeDefined();
    expect(await fs.readFile(f.sourcePath)).toEqual(candidate);
    expect(loaded).toBe(fault === "activation");
    for (const input of f.files.slice(1)) {
      expect(candidate!.toString()).toContain(input);
      await fs.access(input);
    }
    const unlink = fs.unlink.bind(fs);
    vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
      if (f.files.slice(1).includes(String(file))) {
        expect(loaded).toBe(false);
        expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
      }
      await unlink(file);
    });
    await f.capture.compensate();
    expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
    for (const input of f.files.slice(1)) {
      await expect(fs.access(input)).rejects.toMatchObject({ code: "ENOENT" });
    }
  },
);

it("settles a failed activation receipt after the real definition transaction restores A", async () => {
  const f = await fixture("darwin");
  const before = await fingerprintGatewayServiceDefinition(f.command);
  let rewritten: string | undefined;
  await withGatewayServiceRebindCapture(before, async () => {
    await expect(
      reconcileGatewayServiceDefinition({
        env: f.env,
        root: "/old",
        command: f.command,
        expectedCommand: f.command,
        install: async (hooks) => {
          await withGatewayServiceOperationLock(f.env, async (assertCurrent) => {
            await captureGatewayServiceRebind(
              async () => f.command,
              assertCurrent,
              async () => {
                await f.install(hooks);
                rewritten = await fingerprintGatewayServiceDefinition(f.command);
                throw new Error("fixture activation failure");
              },
            );
          });
        },
        warn: () => {},
      }),
    ).rejects.toThrow("fixture activation failure");
    expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
    // Atomic restoration changes file identity even when original bytes are restored.
    const after = await fingerprintGatewayServiceDefinition(f.command);
    expect(after).not.toBe(rewritten);
    expect(currentGatewayServiceRebindReceipt()).toEqual({ before, after, mutated: true });
  });
});

it.each([
  "before-publication",
  "after-publication",
  "updater-revoked",
  "cleanup-uncertain",
] as const)("retains central receipt recovery custody after %s", async (phase) => {
  const f = await fixture("linux");
  const warnings: string[] = [];
  const cleanup = new CommandProcessCleanupError();
  let updaterCurrent = true;
  let candidate: Buffer | undefined;
  const before = await readServiceFileState(f.sourcePath);
  native.identity.mockClear();
  const result = await withGatewayServiceUpdateAuthority(
    () => {
      if (!updaterCurrent) {
        throw new Error("original updater authority expired");
      }
    },
    () =>
      reconcileGatewayServiceDefinition({
        env: f.env,
        root: "/old",
        command: f.command,
        expectedCommand: f.command,
        install: async (hooks) => {
          let callerCurrent = true;
          await withGatewayServiceUpdateAuthority(
            () => {
              if (!callerCurrent) {
                throw new Error("installation caller authority expired");
              }
            },
            async () => {
              if (phase !== "before-publication") {
                await f.install(hooks);
                candidate = await fs.readFile(f.sourcePath);
              }
              if (phase === "cleanup-uncertain") {
                throw cleanup;
              }
              if (phase === "updater-revoked") {
                updaterCurrent = false;
              } else {
                callerCurrent = false;
              }
              assertGatewayServiceUpdateCurrent();
            },
          );
        },
        warn: (message) => warnings.push(message),
      }),
  ).catch((error: unknown) => error);
  if (phase === "cleanup-uncertain") {
    expect(result).toBe(cleanup);
  } else {
    expect(result).toBeInstanceOf(GatewayServiceAuthorityError);
    expect(result).toMatchObject({
      outcome:
        phase === "before-publication"
          ? "unchanged"
          : phase === "after-publication"
            ? "restored"
            : "recovery-pending",
    });
  }
  const reloads = native.identity.mock.calls.filter(([, args]) => args.includes("daemon-reload"));
  if (phase === "before-publication") {
    expect(await readServiceFileState(f.sourcePath)).toEqual(before);
    expect(reloads).toHaveLength(0);
  } else if (phase === "after-publication") {
    expect(reloads).toHaveLength(1);
  } else {
    expect(await fs.readFile(f.sourcePath)).toEqual(candidate);
    expect(reloads).toHaveLength(0);
    expect(warnings).toContainEqual(expect.stringContaining("backups retained"));
    return;
  }
  expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
});

it("preserves typed pre-publication authority failure during central inspection", async () => {
  const f = await fixture("linux");
  f.env.OPENCLAW_PROFILE = "receipt-test";
  const warn = vi.fn();
  const before = await readServiceFileState(f.sourcePath);
  let current = true;
  const command = native.command.getMockImplementation()!;
  native.command.mockImplementation(async () => {
    const result = await command();
    current = false;
    return result;
  });
  const install = vi.fn();
  await expect(
    withGatewayServiceUpdateAuthority(
      () => {
        if (!current) {
          throw new Error("original updater authority expired during inspection");
        }
      },
      () =>
        reconcileGatewayServiceDefinition({
          env: f.env,
          root: "/old",
          command: f.command,
          expectedCommand: f.command,
          install,
          warn,
        }),
    ),
  ).rejects.toMatchObject({ name: "GatewayServiceAuthorityError", outcome: "unchanged" });
  expect(install).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(
    expect.stringMatching(
      /skipped;.*left unchanged.*openclaw --profile receipt-test gateway status --deep/u,
    ),
  );
  expect(await readServiceFileState(f.sourcePath)).toEqual(before);
  expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
});
