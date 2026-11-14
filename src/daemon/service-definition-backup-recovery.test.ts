import "./service-definition-backup.mocks.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { omitExportedTaskDefaults } from "./schtasks-export-defaults.test-support.js";
import { resolveStartupEntryPaths } from "./schtasks-layout.js";
import { restoreGatewayServiceDefinitionBackup } from "./service-definition-backup.js";
import { fixture, native, readRetainedReceipt } from "./service-definition-backup.test-support.js";

describe("service definition backup receipts", () => {
  it.each(["before-create", "after-create", "normalized", "foreign", "during-restore"])(
    "recovers the retained task receipt after interruption: %s",
    async (phase) => {
      const f = await fixture("win32", true);
      if (phase === "during-restore") {
        await f.install();
      }
      const execute = native.task.getMockImplementation()!;
      native.task.mockImplementation(async (args: string[]) => {
        if (args[0] === "/Create" && phase === "before-create") {
          throw new Error("interrupted task publication");
        }
        const result = await execute(args);
        if (args[0] === "/Create") {
          if (phase === "normalized") {
            f.setTask(
              omitExportedTaskDefaults(f.task())
                .replaceAll("<UserId>operator</UserId>", "<UserId>S-1-5-21-1-2-3-1001</UserId>")
                .replace("<RunLevel>LeastPrivilege</RunLevel>", ""),
            );
          } else if (phase === "foreign") {
            f.setTask(f.task().replace("<Count>3</Count>", "<Count>7</Count>"));
          }
          throw new Error("interrupted task publication");
        }
        return result;
      });
      await expect(
        phase === "during-restore"
          ? restoreGatewayServiceDefinitionBackup({ ...f, receipt: await f.capture.finish() })
          : f.install(),
      ).rejects.toThrow("interrupted task publication");
      native.task.mockImplementation(execute);
      const readReceipt = () => readRetainedReceipt(f.capture.backupPaths);
      const receipt = await readReceipt();
      if (phase === "foreign") {
        const files = await Promise.all(f.files.map((file) => fs.readFile(file)));
        await expect(restoreGatewayServiceDefinitionBackup({ ...f, receipt })).rejects.toThrow(
          "Scheduled Task changed",
        );
        expect(f.task()).toContain("<Count>7</Count>");
        expect(await Promise.all(f.files.map((file) => fs.readFile(file)))).toEqual(files);
        return;
      }
      await restoreGatewayServiceDefinitionBackup({ ...f, receipt });
      expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
      expect(f.task()).toBe(f.originalTask);
      expect((await readReceipt()).task).toMatchObject({
        recoveredPolicy: phase === "before-create" ? "previous" : "prepared",
      });
    },
  );

  it.each([
    "Settings.RestartOnFailure.Count",
    "Settings.Priority",
    "Actions.Exec.Command",
    "RegistrationInfo.Description",
    "verified snapshot",
  ])(
    "rejects an intervening native publication edit to %s without absorbing it into rollback",
    async (key) => {
      const f = await fixture("win32");
      const execute = native.task.getMockImplementation()!;
      let published = false;
      let edited = false;
      native.task.mockImplementation(async (args: string[]) => {
        const result = await execute(args);
        if (key === "verified snapshot") {
          if (args[0] === "/Create") {
            published = true;
          } else if (published && !edited && args[0] === "/Query" && args.includes("/XML")) {
            edited = true;
            f.setTask(f.task().replace("<Count>3</Count>", "<Count>7</Count>"));
          }
        } else if (args[0] === "/Create") {
          f.setTask(
            key === "Settings.RestartOnFailure.Count"
              ? f.task().replace("<Count>3</Count>", "<Count>7</Count>")
              : key === "Settings.Priority"
                ? omitExportedTaskDefaults(f.task()).replace(
                    "</Settings>",
                    "<Priority>4</Priority></Settings>",
                  )
                : key === "Actions.Exec.Command"
                  ? f
                      .task()
                      .replace(
                        /<Command>[^<]*<\/Command>/u,
                        "<Command>operator-private.cmd</Command>",
                      )
                  : f
                      .task()
                      .replace(
                        /<Description>[^<]*<\/Description>/u,
                        "<Description>operator-private</Description>",
                      ),
          );
        }
        return result;
      });
      await expect(f.install()).rejects.toThrow(
        key === "verified snapshot" ? "Scheduled Task changed" : key,
      );
      if (key === "verified snapshot") {
        expect(edited).toBe(true);
      }
      const observed = f.task();
      expect(
        native.task.mock.calls.some(([args]) => args[0] === "/Change" || args[0] === "/Run"),
      ).toBe(false);
      await expect(f.capture.compensate()).rejects.toThrow("Scheduled Task changed");
      expect(f.task()).toBe(observed);
      expect(native.task.mock.calls.filter(([args]) => args[0] === "/Create")).toHaveLength(1);
    },
  );

  it("verifies the submitted policy across native SID, default and registration normalization", async () => {
    const f = await fixture("win32");
    const execute = native.task.getMockImplementation()!;
    native.task.mockImplementation(async (args: string[]) => {
      const result = await execute(args);
      if (args[0] === "/Create") {
        f.setTask(
          omitExportedTaskDefaults(f.task())
            .replaceAll("<UserId>operator</UserId>", "<UserId>S-1-5-21-1-2-3-1001</UserId>")
            .replace("<RunLevel>LeastPrivilege</RunLevel>", "")
            .replace(
              "<Settings>",
              "<Settings><UseUnifiedSchedulingEngine>false</UseUnifiedSchedulingEngine>",
            )
            .replace(
              "<RegistrationInfo>",
              "<RegistrationInfo><Date>2026-09-04T00:00:00Z</Date><Author>operator</Author><URI>\\OpenClaw Gateway</URI>",
            )
            .replace(/(<Settings>[\s\S]*?)<Enabled>true<\/Enabled>/u, "$1<Enabled>false</Enabled>"),
        );
      }
      return result;
    });
    await f.install();
    expect(f.task()).toContain("<Count>3</Count>");
    expect(f.task()).toContain("<Interval>PT1M</Interval>");
    expect(native.identity).toHaveBeenCalled();
    expect(native.task.mock.calls.some(([args]) => args[0] === "/Run")).toBe(true);
    const receipt = await f.capture.finish();
    expect(receipt).toMatchObject({ task: { afterPolicySha256: expect.any(String) } });
    expect(f.task()).not.toContain("<Priority>");
    expect(await fs.readFile(f.sourcePath, "utf8")).toContain("OPERATOR_SETTING=new-value");
    // A later autostart choice remains independent of equivalent XML defaults.
    f.setTask(
      f
        .task()
        .replace(/(<Settings>[\s\S]*?)<Enabled>true<\/Enabled>/u, "$1<Enabled>false</Enabled>"),
    );
    native.task.mockImplementation(execute);
    await restoreGatewayServiceDefinitionBackup({ ...f, receipt });
    expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
    expect(f.task()).toBe(
      f.originalTask.replace(
        /(<Settings>[\s\S]*?)<Enabled>true<\/Enabled>/u,
        "$1<Enabled>false</Enabled>",
      ),
    );
  });

  it("preserves coexisting Startup files during a receipt-owned Scheduled Task install", async () => {
    const f = await fixture("win32");
    f.env.OPENCLAW_GATEWAY_PORT = "19305";
    const startupFiles = resolveStartupEntryPaths(f.env).map((file, index) => ({
      file,
      contents: Buffer.from(`operator login item ${index}\r\n`),
    }));
    for (const { file, contents } of startupFiles) {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(file, contents, { mode: 0o600 });
    }
    await f.install();
    await expect(f.capture.finish()).resolves.toMatchObject({
      task: { afterPolicySha256: expect.any(String) },
    });
    for (const { file, contents } of startupFiles) {
      expect(await fs.readFile(file)).toEqual(contents);
    }
    expect(native.task.mock.calls.filter(([args]) => args[0] === "/Run")).toHaveLength(1);
    expect(native.task.mock.calls.some(([args]) => args[0] === "/End")).toBe(false);
  });

  it.each(["registration denied", "policy write failed"])(
    "preserves the task and compensates its script after %s",
    async (failure) => {
      const f = await fixture("win32");
      const execute = native.task.getMockImplementation()!;
      native.task.mockImplementation(async (args: string[]) =>
        args[0] === "/Create" ||
        (failure === "registration denied" && args[0] === "/Query" && !args.includes("/XML"))
          ? { code: 1, stdout: "", stderr: "ERROR: Access is denied." }
          : execute(args),
      );
      await expect(f.install()).rejects.toThrow(
        failure === "registration denied"
          ? "startup fallback is unsupported"
          : "definition upgrade failed",
      );
      if (failure === "registration denied") {
        expect(f.task()).toBe(f.originalTask);
        for (const file of resolveStartupEntryPaths(f.env)) {
          await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(native.task.mock.calls.some(([args]) => args[0] === "/Run")).toBe(false);
      } else {
        expect(await fs.readFile(f.sourcePath)).not.toEqual(f.original);
        native.task.mockImplementation(execute);
        await f.capture.compensate();
        expect(await fs.readFile(f.sourcePath)).toEqual(f.original);
        expect(f.task()).toBe(f.originalTask);
        await expect(fs.stat(f.files[1]!)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );
});
