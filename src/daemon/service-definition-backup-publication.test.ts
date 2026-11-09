import "./service-definition-backup.mocks.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { restartLaunchAgent } from "./launchd-lifecycle.js";
import { buildLaunchAgentPlist } from "./launchd-plist.js";
import { restoreGatewayServiceDefinitionBackup } from "./service-definition-backup.js";
import { fixture, native, readRetainedReceipt } from "./service-definition-backup.test-support.js";
import { GatewayServiceDefinitionBackupReceiptSchema } from "./service-stage.js";
import { stageSystemdService } from "./systemd-install.js";
import { restartSystemdService } from "./systemd-lifecycle.js";
import { parseSystemdExecStart } from "./systemd-unit.js";

describe("service definition backup receipts", () => {
  it.each(["expired", "interrupted-reload"])(
    "reloads the restored systemd definition before retiring its old inputs: %s",
    async (mode) => {
      const f = await fixture("linux");
      await stageSystemdService({
        env: f.env,
        stdout: new PassThrough(),
        programArguments: ["/usr/bin/node", "/new/index.js", "gateway"],
        environment: { ...f.command.environment, OPERATOR_SETTING: "candidate" },
        environmentValueSources: { OPERATOR_SETTING: "file" },
        definitionTransaction: f.capture.hooks,
      });
      let receipt = await f.capture.finish();
      let loaded = await fs.readFile(f.sourcePath, "utf8");
      expect(loaded).toContain("EnvironmentFile=");
      const loadedArguments = () => parseSystemdExecStart(/^ExecStart=(.*)$/mu.exec(loaded)![1]!);
      native.command.mockImplementation(async () => {
        if (loaded.includes("EnvironmentFile=")) {
          await fs.access(f.files[1]!);
        }
        return { ...f.command, programArguments: loadedArguments() };
      });
      let started: string[] | undefined;
      let interrupt = mode === "interrupted-reload";
      native.identity.mockImplementation(async (command, args) => {
        expect(command).toBe("systemctl");
        if (args.includes("daemon-reload")) {
          expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
          await fs.access(f.files[1]!);
          if (interrupt) {
            interrupt = false;
            throw new Error("interrupted before daemon-reload");
          }
          loaded = await fs.readFile(f.sourcePath, "utf8");
        } else if (args.includes("restart")) {
          started = loadedArguments();
        } else {
          expect(args).toContain("reset-failed");
        }
        return { code: 0, stdout: "", stderr: "", termination: "exit" };
      });
      if (mode === "expired") {
        native.transport.mockImplementation(async () => {
          f.expire();
          return undefined;
        });
        await expect(restoreGatewayServiceDefinitionBackup({ ...f, receipt })).rejects.toThrow(
          "expired authority",
        );
        expect(native.identity).not.toHaveBeenCalled();
        await fs.access(f.files[1]!);
        return;
      }
      if (mode === "interrupted-reload") {
        await expect(restoreGatewayServiceDefinitionBackup({ ...f, receipt })).rejects.toThrow(
          "interrupted before daemon-reload",
        );
        expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
        expect(loaded).toContain("EnvironmentFile=");
        receipt = await readRetainedReceipt(f.capture.backupPaths);
      }
      await restoreGatewayServiceDefinitionBackup({ ...f, receipt });
      expect(loaded).toBe(f.original.toString("utf8"));
      await expect(fs.stat(f.files[1]!)).rejects.toMatchObject({ code: "ENOENT" });
      await restartSystemdService({
        env: f.env,
        stdout: new PassThrough(),
        preserveDefinition: true,
        assertCurrent: f.assertCurrent,
      });
      expect(started).toEqual(f.command.programArguments);
    },
  );

  it.each(["stopped", "absent", "unknown"])(
    "restores launchd disk and cached definition with a %s job",
    async (job) => {
      const original = Buffer.from(
        buildLaunchAgentPlist({
          label: "ai.openclaw.receipt-fixture",
          programArguments: ["/usr/bin/node", "/old/index.js", "gateway"],
          stdoutPath: "/fixture/gateway.log",
          stderrPath: "/fixture/gateway.log",
        }),
      );
      const f = await fixture("darwin", false, original);
      await f.install();
      const receipt = await f.capture.finish();
      const candidate = await fs.readFile(f.sourcePath);
      let cached: Buffer | null = job === "absent" ? null : candidate;
      let started: Buffer | undefined;
      native.launchctl.mockImplementation(async (args) => {
        expect(args.some((arg) => arg.includes("ai.openclaw.receipt-fixture"))).toBe(true);
        const ok = { code: 0, stdout: "", stderr: "", termination: "exit" as const };
        const missing = { ...ok, code: 113, stderr: "Could not find service" };
        if (args[0] === "print") {
          return job === "unknown"
            ? { ...ok, code: 13, stderr: "Access denied" }
            : cached
              ? { ...ok, stdout: `${args[1]} = {\n\tstate = waiting\n}` }
              : missing;
        }
        if (args[0] === "bootout") {
          expect(await fs.readFile(f.sourcePath)).toEqual(candidate);
          cached = null;
        } else if (args[0] === "bootstrap") {
          cached = await fs.readFile(f.sourcePath);
        } else if (args[0] === "kickstart") {
          if (!cached) {
            return missing;
          }
          started = cached;
        } else {
          expect(args[0]).toBe("enable");
        }
        return ok;
      });
      if (job === "unknown") {
        await expect(restoreGatewayServiceDefinitionBackup({ ...f, receipt })).rejects.toThrow(
          "Cached LaunchAgent definition",
        );
        expect(await fs.readFile(f.sourcePath)).toEqual(candidate);
        expect(cached).toEqual(candidate);
        expect(native.launchctl.mock.calls.every(([args]) => args[0] === "print")).toBe(true);
        return;
      }
      await restoreGatewayServiceDefinitionBackup({ ...f, receipt });
      expect(cached).toBeNull();
      expect(native.launchctl.mock.calls.some(([args]) => args[0] === "bootout")).toBe(
        job === "stopped",
      );
      expect(
        native.launchctl.mock.calls.some(([args]) =>
          ["enable", "bootstrap", "kickstart"].includes(args[0]!),
        ),
      ).toBe(false);
      await restartLaunchAgent({ env: f.env, stdout: new PassThrough(), preserveDefinition: true });
      expect(started).toEqual(original);
    },
  );
  it.each([false, true])(
    "restores a released numeric service receipt without replacing a newer file (replaced=%s)",
    async (replaced) => {
      const platform = process.platform === "win32" ? "win32" : "linux";
      const f = await fixture(platform, true);
      const originalFiles = await Promise.all(
        f.files.map(async (file) => ({
          file,
          contents: await fs.readFile(file),
          mode: (await fs.stat(file)).mode & 0o777,
        })),
      );
      await f.install();
      // v2026.10.2 stored numeric dev/ino in every retained service file state.
      const exactReceipt = await f.capture.finish();
      const serialized = JSON.stringify(exactReceipt, (key, value: unknown) => {
        if ((key === "dev" || key === "ino") && typeof value === "string") {
          return Number(BigInt.asUintN(64, BigInt(value)));
        }
        return value;
      });
      const receipt = GatewayServiceDefinitionBackupReceiptSchema.parse(JSON.parse(serialized));
      expect(receipt.files[0]!.after!.ino).toBe(
        Number(BigInt.asUintN(64, BigInt(exactReceipt.files[0]!.after!.ino))),
      );
      const candidate = await fs.readFile(f.sourcePath);
      if (replaced) {
        const replacement = `${f.sourcePath}.operator`;
        await fs.writeFile(replacement, candidate, { mode: 0o600 });
        await fs.rename(replacement, f.sourcePath);
        const replacementIdentity = await fs.stat(f.sourcePath, { bigint: true });
        await expect(restoreGatewayServiceDefinitionBackup({ ...f, receipt })).rejects.toThrow(
          "Service definition changed",
        );
        expect(await fs.readFile(f.sourcePath)).toEqual(candidate);
        expect(await fs.stat(f.sourcePath, { bigint: true })).toMatchObject({
          dev: replacementIdentity.dev,
          ino: replacementIdentity.ino,
        });
        return;
      }
      await restoreGatewayServiceDefinitionBackup({ ...f, receipt });
      const upgraded = await readRetainedReceipt(f.capture.backupPaths);
      for (const file of upgraded.files) {
        if (file.after) {
          const current = await fs.stat(file.sourcePath, { bigint: true });
          expect(file.after).toMatchObject({
            dev: current.dev.toString(),
            ino: current.ino.toString(),
          });
        }
      }
      for (const original of originalFiles) {
        expect(await fs.readFile(original.file)).toEqual(original.contents);
        const mode = (await fs.stat(original.file)).mode & 0o777;
        if (platform === "win32") {
          // Windows chmod represents writability; service receipts do not retain DACLs.
          expect(mode).toBe(original.mode);
          expect(mode & 0o200).toBe(0o200);
          await fs.access(original.file, fs.constants.R_OK | fs.constants.W_OK);
        } else {
          expect(mode).toBe(0o600);
        }
      }
    },
  );

  it.each([
    { platform: "win32", ancillary: false },
    { platform: "darwin", ancillary: true },
  ] as const)(
    "backs up before native $platform publication (ancillary=$ancillary) and restores exact bytes from a serialized receipt",
    async ({ platform, ancillary }) => {
      const f = await fixture(platform, ancillary);
      expect(await fs.readFile(f.capture.backupPaths[0]!)).toEqual(f.original);
      expect((await fs.stat(f.capture.backupPaths[0]!)).mode & 0o777).toBe(0o600);
      await f.install();
      const serializedReceipt = JSON.stringify(await f.capture.finish());
      const receipt = GatewayServiceDefinitionBackupReceiptSchema.parse(
        JSON.parse(serializedReceipt),
      );
      expect(await fs.readFile(f.sourcePath)).not.toEqual(f.original);
      if (platform === "win32") {
        expect(f.task()).toContain("<Count>3</Count>");
        f.setTask(
          f
            .task()
            .replace(/(<Settings>[\s\S]*?)<Enabled>true<\/Enabled>/u, "$1<Enabled>false</Enabled>"),
        );
      }
      await restoreGatewayServiceDefinitionBackup({ ...f, receipt });
      expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
      expect((await fs.stat(f.sourcePath)).mode & 0o777).toBe(0o600);
      for (const file of f.files.slice(1)) {
        if (ancillary) {
          expect(await fs.readFile(file, "utf8")).toBe("OPERATOR_SETTING=old-value\n");
          expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
        } else {
          await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
      if (platform === "win32") {
        expect(f.task()).toBe(
          f.originalTask.replace(
            /(<Settings>[\s\S]*?)<Enabled>true<\/Enabled>/u,
            "$1<Enabled>false</Enabled>",
          ),
        );
      }
    },
  );

  it.each([
    { platform: "linux", dropIn: false },
    { platform: "darwin", dropIn: false },
    { platform: "win32", dropIn: false },
    { platform: "linux", dropIn: true },
  ] as const)(
    "rejects $platform edits between capture and publication (drop-in=$dropIn)",
    async ({ platform, dropIn }) => {
      const f = await fixture(platform);
      const target = `${f.sourcePath}.d/operator.conf`;
      if (dropIn) {
        await fs.mkdir(path.dirname(target), { mode: 0o700 });
        await fs.writeFile(target, "[Service]\nNice=7\n", { mode: 0o600 });
        f.command.definitionPaths!.push(target);
      } else {
        await fs.appendFile(f.sourcePath, "operator-edit");
      }
      await expect(f.install()).rejects.toThrow(
        dropIn ? "different managed artifacts" : "Service definition changed",
      );
      expect(await fs.readFile(f.sourcePath)).toEqual(
        dropIn ? f.original : Buffer.concat([f.original, Buffer.from("operator-edit")]),
      );
      if (dropIn) {
        expect(await fs.readFile(target, "utf8")).toContain("Nice=7");
      }
    },
  );

  it.each(["later edit", "damaged backup", "expired authority", "foreign path", "task XML edit"])(
    "refuses rollback for %s before changing any file",
    async (fault) => {
      const f = await fixture(fault === "task XML edit" ? "win32" : "darwin", true);
      await f.install();
      const receipt = await f.capture.finish();
      if (fault === "task XML edit") {
        f.setTask(f.task().replace("<Count>3</Count>", "<Count>7</Count>"));
      }
      if (fault === "later edit") {
        await fs.appendFile(f.sourcePath, "operator-edit");
      }
      if (fault === "damaged backup") {
        await fs.writeFile(
          f.capture.backupPaths.findLast((file) => !file.endsWith(".receipt.bak"))!,
          "damaged",
        );
      }
      if (fault === "expired authority") {
        f.expire();
      }
      if (fault === "foreign path") {
        receipt.files[0]!.sourcePath = `${f.sourcePath}.foreign`;
      }
      const before = await Promise.all(f.files.map((file) => fs.readFile(file)));
      const restoration = restoreGatewayServiceDefinitionBackup({ ...f, receipt });
      if (fault === "task XML edit") {
        await expect(restoration).rejects.toThrow("Scheduled Task changed");
        expect(f.task()).toContain("<Count>7</Count>");
      } else {
        await expect(restoration).rejects.toThrow();
      }
      expect(await Promise.all(f.files.map((file) => fs.readFile(file)))).toEqual(before);
    },
  );

  it.skipIf(process.platform === "win32")(
    "restores full LaunchAgent permission bits from its receipt",
    async () => {
      const f = await fixture("darwin", false, undefined, 0o4600);
      await f.install();
      await restoreGatewayServiceDefinitionBackup({ ...f, receipt: await f.capture.finish() });
      expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
      expect((await fs.stat(f.sourcePath)).mode & 0o7777).toBe(0o4600);
    },
  );
});
