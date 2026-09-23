import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  SUCCESS_RESPONSE,
  resumeScheduledTaskAutoStartAfterUpdate,
  spawnSync,
  suspendScheduledTaskAutoStartForUpdate,
  withPreparedGatewayTask,
} from "./schtasks.stop.test-support.js";
import { schtasksCalls, schtasksResponses } from "./test-helpers/schtasks-fixtures.js";

describe("Scheduled Task stop/restart cleanup", () => {
  it("suspends a task whose Settings.Enabled value uses the default", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push(
        {
          ...SUCCESS_RESPONSE,
          stdout: "<Task><Settings><StartWhenAvailable>true</StartWhenAvailable></Settings></Task>",
        },
        { ...SUCCESS_RESPONSE },
      );

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).resolves.toBe(true);

      expect(schtasksCalls).toEqual([
        ["/Query", "/TN", "OpenClaw Gateway", "/XML"],
        ["/Change", "/TN", "OpenClaw Gateway", "/DISABLE"],
      ]);
    });
  });

  it("preserves an already-disabled task", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push({
        ...SUCCESS_RESPONSE,
        stdout:
          "<Task><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Settings><Enabled>false</Enabled></Settings></Task>",
      });

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).resolves.toBe(false);

      expect(schtasksCalls).toEqual([["/Query", "/TN", "OpenClaw Gateway", "/XML"]]);
    });
  });

  it("fails closed when task absence cannot be confirmed", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push({
        code: 1,
        stdout: "",
        stderr: "ERROR: The system cannot find the file specified.",
      });

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).rejects.toThrow(
        "schtasks XML query failed: ERROR: The system cannot find the file specified.",
      );

      expect(schtasksCalls).toEqual([["/Query", "/TN", "OpenClaw Gateway", "/XML"]]);
      expect(spawnSync).toHaveBeenCalledOnce();
    });
  });

  it("ignores a stale task script when COM proves the task is absent", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push({
        code: 1,
        stdout: "",
        stderr: "FEHLER: Die angegebene Datei wurde nicht gefunden.",
      });
      spawnSync.mockReturnValueOnce({
        pid: 0,
        output: [null, "-2147024894", ""],
        stdout: "-2147024894",
        stderr: "",
        status: 1,
        signal: null,
      });

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).resolves.toBe(false);

      expect(schtasksCalls).toEqual([["/Query", "/TN", "OpenClaw Gateway", "/XML"]]);
      expect(spawnSync).toHaveBeenCalledOnce();
    });
  });

  it("fails closed when the task enabled state is missing", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push({ ...SUCCESS_RESPONSE, stdout: "<Task><Triggers /></Task>" });

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).rejects.toThrow(
        "schtasks XML query did not expose the task enabled state",
      );
    });
  });

  it("restores an enabled task after an ambiguous disable failure", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push(
        {
          ...SUCCESS_RESPONSE,
          stdout: "<Task><Settings><Enabled>true</Enabled></Settings></Task>",
        },
        { code: 124, stdout: "", stderr: "schtasks timed out after 15000ms" },
        { ...SUCCESS_RESPONSE },
      );

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).rejects.toThrow(
        "schtasks disable failed: schtasks timed out after 15000ms",
      );

      expect(schtasksCalls).toEqual([
        ["/Query", "/TN", "OpenClaw Gateway", "/XML"],
        ["/Change", "/TN", "OpenClaw Gateway", "/DISABLE"],
        ["/Change", "/TN", "OpenClaw Gateway", "/ENABLE"],
      ]);
    });
  });

  it("leaves startup-folder fallback installs unchanged when the task is absent", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      const startupEntry = path.join(
        expectDefined(env.APPDATA, "env.APPDATA test invariant"),
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "Startup",
        "OpenClaw Gateway.cmd",
      );
      await fs.mkdir(path.dirname(startupEntry), { recursive: true });
      await fs.writeFile(startupEntry, "@echo off\r\n", "utf8");
      schtasksResponses.push({
        code: 1,
        stdout: "",
        stderr: "FEHLER: Die angegebene Datei wurde nicht gefunden.",
      });
      spawnSync.mockReturnValueOnce({
        pid: 0,
        output: [null, "-2147024894", ""],
        stdout: "-2147024894",
        stderr: "",
        status: 1,
        signal: null,
      });

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).resolves.toBe(false);

      expect(schtasksCalls).toEqual([["/Query", "/TN", "OpenClaw Gateway", "/XML"]]);
      expect(spawnSync).toHaveBeenCalledOnce();
    });
  });

  it("fails closed on an ambiguous task query even when a startup entry exists", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      const startupEntry = path.join(
        expectDefined(env.APPDATA, "env.APPDATA test invariant"),
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "Startup",
        "OpenClaw Gateway.cmd",
      );
      await fs.mkdir(path.dirname(startupEntry), { recursive: true });
      await fs.writeFile(startupEntry, "@echo off\r\n", "utf8");
      schtasksResponses.push({ code: 1, stdout: "", stderr: "ERROR: Access is denied." });

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).rejects.toThrow(
        "schtasks XML query failed: ERROR: Access is denied.",
      );
      expect(spawnSync).toHaveBeenCalledOnce();
    });
  });

  it("reads NUL-separated Scheduled Task XML", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      const xml = "<Task><Settings><Enabled>true</Enabled></Settings></Task>";
      schtasksResponses.push(
        { ...SUCCESS_RESPONSE, stdout: `\uFEFF${xml.split("").join("\u0000")}` },
        { ...SUCCESS_RESPONSE },
      );

      await expect(suspendScheduledTaskAutoStartForUpdate(env)).resolves.toBe(true);
    });
  });

  it("reenables a task after the update window", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push({ ...SUCCESS_RESPONSE });

      await expect(resumeScheduledTaskAutoStartAfterUpdate(env)).resolves.toBe(true);

      expect(schtasksCalls).toEqual([["/Change", "/TN", "OpenClaw Gateway", "/ENABLE"]]);
    });
  });

  it("surfaces a failed task reenable", async () => {
    await withPreparedGatewayTask(async ({ env }) => {
      schtasksResponses.push({ code: 1, stdout: "", stderr: "ERROR: Access is denied." });

      await expect(resumeScheduledTaskAutoStartAfterUpdate(env)).rejects.toThrow(
        "schtasks enable failed: ERROR: Access is denied.",
      );
    });
  });
});
