import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  findExtraGatewayServices,
  listManagedOpenClawGatewayServices,
  renderGatewayServiceCleanupHints,
} from "./inspect.js";
import type { ScheduledTaskSnapshot } from "./schtasks-state-probe.js";

const { listScheduledTasksMock, readScheduledTaskCommandMock } = vi.hoisted(() => ({
  listScheduledTasksMock: vi.fn<typeof import("./schtasks-state-probe.js").listScheduledTasks>(),
  readScheduledTaskCommandMock:
    vi.fn<typeof import("./schtasks-layout.js").readScheduledTaskCommand>(),
}));

vi.mock("./schtasks-state-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./schtasks-state-probe.js")>()),
  listScheduledTasks: listScheduledTasksMock,
}));
vi.mock("./schtasks-layout.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./schtasks-layout.js")>()),
  readScheduledTaskCommand: readScheduledTaskCommandMock,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("findExtraGatewayServices (win32)", () => {
  const originalPlatform = process.platform;
  let nativeEnv: { APPDATA: string };
  const task = (taskPath: string, executable: string, args: string) => ({
    taskPath,
    state: null,
    actions: [{ type: 0, path: executable, arguments: args, workingDirectory: "" }],
  });

  beforeEach(() => {
    nativeEnv = { APPDATA: tempDirs.make("openclaw-windows-inventory-") };
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    listScheduledTasksMock.mockReset().mockReturnValue([]);
    readScheduledTaskCommandMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  });

  it("skips Scheduled Task queries unless deep mode is enabled", async () => {
    await expect(findExtraGatewayServices({})).resolves.toEqual({ services: [], errors: [] });
    expect(listScheduledTasksMock).not.toHaveBeenCalled();
  });

  it("reports query failures as incomplete inspection without inventing a cleanup target", async () => {
    listScheduledTasksMock.mockImplementation(() => {
      throw new Error("Access denied");
    });

    const result = await findExtraGatewayServices(nativeEnv, { deep: true });

    expect(result).toEqual({
      services: [],
      errors: [{ source: "schtasks", message: expect.stringContaining("could not be queried") }],
    });
    expect(renderGatewayServiceCleanupHints(result.services)).toEqual([]);
    await expect(listManagedOpenClawGatewayServices(nativeEnv)).resolves.toEqual(result);
  });

  it("keeps verified Node and legacy services while rejecting an unrelated branded monitor", async () => {
    listScheduledTasksMock.mockReturnValue([
      task("\\OpenClaw Gateway", "C:\\OpenClaw\\openclaw.exe", "gateway run"),
      task("\\OpenClaw Gateway (dev)", "C:\\OpenClaw\\openclaw.exe", "gateway run --profile dev"),
      task("\\OpenClaw Gateway Backup", "C:\\OpenClaw\\openclaw.exe", "gateway run"),
      task(
        "\\OpenClaw Node",
        "C:\\Program Files\\nodejs\\node.exe",
        '"C:\\OpenClaw\\dist\\entry.js" node run',
      ),
      task("\\Clawdbot Legacy", "C:\\clawdbot\\clawdbot.exe", "run"),
      task(
        "\\OpenClaw Gateway Monitor",
        "C:\\tools\\monitor.exe",
        "--gateway-url http://127.0.0.1:18789",
      ),
      {
        taskPath: "\\OpenClaw CrossAction",
        state: null,
        actions: [
          {
            type: 0,
            path: "C:\\OpenClaw\\openclaw.exe",
            arguments: "node run",
            workingDirectory: "",
          },
          {
            type: 0,
            path: "C:\\tools\\helper.exe",
            arguments: "gateway run",
            workingDirectory: "",
          },
        ],
      },
    ]);

    const result = await findExtraGatewayServices(nativeEnv, { deep: true });

    expect(result.errors).toEqual([]);
    expect(result.services).toEqual([
      expect.objectContaining({
        label: "\\OpenClaw Gateway Backup",
        marker: "openclaw",
        legacy: false,
      }),
      expect.objectContaining({ label: "\\OpenClaw Node", marker: "openclaw", legacy: false }),
      expect.objectContaining({ label: "\\Clawdbot Legacy", marker: "clawdbot", legacy: true }),
      expect.objectContaining({
        label: "\\OpenClaw CrossAction",
        marker: "openclaw",
        legacy: false,
      }),
    ]);
    expect(renderGatewayServiceCleanupHints(result.services).join("\n")).not.toContain("Monitor");
    const managed = await listManagedOpenClawGatewayServices(nativeEnv);
    expect(managed.errors).toEqual([]);
    expect(managed.services.map((service) => service.label)).toEqual([
      "\\OpenClaw Gateway",
      "\\OpenClaw Gateway (dev)",
      "\\OpenClaw Gateway Backup",
    ]);
    for (const service of result.services) {
      expect(service).not.toHaveProperty("windowsProfile");
    }
    for (const service of [...managed.services, ...result.services]) {
      expect(service).not.toHaveProperty("extra");
      expect(service).not.toHaveProperty("managedGateway");
    }
  });

  it.each(["gateway", "node"])(
    "recognizes verified %s launcher metadata independently of the task label",
    async (kind) => {
      listScheduledTasksMock.mockReturnValue([
        task("\\Custom Service", "C:\\fixtures\\service.cmd", ""),
      ]);
      readScheduledTaskCommandMock.mockResolvedValue({
        programArguments: ["C:\\runtime\\node.exe", "C:\\app\\entry.js", kind, "run"],
        environment: { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: kind },
      });

      const result = await findExtraGatewayServices(nativeEnv, { deep: true });

      expect(result.errors).toEqual([]);
      expect(result.services).toEqual([
        expect.objectContaining({ label: "\\Custom Service", marker: "openclaw", legacy: false }),
      ]);
      const managed = await listManagedOpenClawGatewayServices(nativeEnv);
      expect(managed).toEqual({
        services: kind === "gateway" ? [{ ...result.services[0], windowsProfile: "default" }] : [],
        errors: [],
      });
    },
  );

  it.each([
    ["modern Gateway", "Services\\Selected Gateway", "openclaw", "gateway run", false, true],
    ["legacy command", "Services\\Selected Legacy", "clawdbot", "run", true, false],
    ["upgraded legacy task", "Clawdbot Gateway", "openclaw", "gateway run", true, true],
    ["Node", "Services\\Selected Node", "openclaw", "node run", true, false],
  ] as const)(
    "keeps selected %s diagnostic and managed projections separate",
    async (_kind, name, marker, args, extra, managedGateway) => {
      const label = `\\${name}`;
      listScheduledTasksMock.mockReturnValue([task(label, `C:\\${marker}\\${marker}.exe`, args)]);
      const env = { ...nativeEnv, OPENCLAW_WINDOWS_TASK_NAME: name };
      const extras = await findExtraGatewayServices(env, { deep: true });
      expect(extras.errors).toEqual([]);
      expect(extras.services).toEqual(extra ? [expect.objectContaining({ label, marker })] : []);
      expect(renderGatewayServiceCleanupHints(extras.services)).toEqual(
        extra ? [`schtasks /Query /TN "${label}" /V /FO LIST`] : [],
      );
      const managed = await listManagedOpenClawGatewayServices(env);
      expect(managed.services).toEqual(
        managedGateway ? [expect.objectContaining({ label, marker: "openclaw" })] : [],
      );
      expect(managed.errors).toEqual([]);
    },
  );

  type IncompleteCase = {
    name: string;
    tasks: ScheduledTaskSnapshot[];
    selected?: string;
    read?: "missing" | "unreadable" | "recognizable";
    projection?: "extras" | "both";
    sources: string[];
    message?: string;
    exact?: boolean;
  };
  const knownLabels = ["\\OpenClaw Gateway (dev)", "\\Clawdbot Gateway"];
  const missingLabels = [...knownLabels, "\\Custom Service"];
  const custom = "\\Custom Assistant";
  it.each<IncompleteCase>([
    ...[undefined, []].map((actions) => ({
      name: `known selectors with ${actions ? "empty" : "missing"} actions`,
      tasks: ["\\OpenClaw Gateway", "\\Selected Custom"].map((taskPath) => ({
        taskPath,
        state: null,
        actions,
      })),
      selected: "\\Selected Custom",
      projection: "both" as const,
      sources: ["\\OpenClaw Gateway", "\\Selected Custom"],
    })),
    ...knownLabels.map((label) => ({
      name: `unreadable known launcher ${label}`,
      tasks: [task(label, "C:\\custom\\gateway.cmd", "")],
      read: "unreadable" as const,
      projection: "both" as const,
      sources: [label],
      exact: true,
    })),
    ...["missing action", "unreadable launcher", "disappeared launcher", "multiple actions"].map(
      (fault) => {
        const selected = task(custom, "C:\\custom\\assistant.cmd", "");
        if (fault === "missing action") {
          selected.actions = [];
        }
        if (fault === "multiple actions") {
          selected.actions = [0, 1].map(
            () => task(custom, "C:\\OpenClaw\\openclaw.exe", "gateway run").actions[0]!,
          );
        }
        return {
          name: `selected custom task with ${fault}`,
          tasks: [selected],
          selected: custom,
          read: fault === "unreadable launcher" ? ("unreadable" as const) : ("missing" as const),
          sources: [custom],
        };
      },
    ),
    {
      name: "unrelated running tasks with unreadable or missing actions",
      tasks: [
        { ...task("\\Maintenance", "C:\\tools\\maintenance.cmd", ""), state: 4 },
        { taskPath: "\\Native Maintenance", state: 4, actions: [] },
      ],
      read: "unreadable",
      sources: [],
    },
    {
      name: "disappeared OpenClaw launchers with unknown native state",
      tasks: missingLabels.map((label) => task(label, "C:\\OpenClaw\\gateway.cmd", "")),
      read: "missing",
      sources: missingLabels,
      exact: true,
    },
    {
      name: "mixed task whose later action runs the Gateway",
      tasks: [
        {
          ...task("\\Mixed Assistant", "C:\\clawdbot\\clawdbot.exe", "run"),
          actions: [
            task(custom, "C:\\clawdbot\\clawdbot.exe", "run").actions[0]!,
            task(custom, "C:\\OpenClaw\\openclaw.exe", "gateway run").actions[0]!,
          ],
        },
      ],
      sources: ["\\Mixed Assistant"],
      message: "Multiple Scheduled Task actions",
    },
    ...[
      ["direct", "C:\\custom\\assistant.bat", ""],
      ["through cmd.exe", "C:\\Windows\\System32\\cmd.exe", "/c C:\\custom\\assistant.bat"],
    ].map(([mode, executable, args]) => ({
      name: `uninspectable selected BAT launcher ${mode}`,
      tasks: [task(custom, executable!, args!)],
      selected: custom,
      read: "unreadable" as const,
      sources: [custom],
      exact: true,
    })),
    {
      name: "recognizable launcher with an unreadable nested launcher",
      tasks: [task("\\Custom Service", "C:\\fixtures\\service.cmd", "")],
      read: "recognizable",
      projection: "extras",
      sources: ["\\Custom Service"],
    },
  ])(
    "qualifies incomplete inventory: $name",
    async ({ tasks, selected, read, projection, sources, message, exact }) => {
      listScheduledTasksMock.mockReturnValue(tasks);
      if (read === "missing") {
        readScheduledTaskCommandMock.mockResolvedValue(null);
      }
      if (read === "unreadable") {
        readScheduledTaskCommandMock.mockRejectedValue(new Error("Access denied"));
      }
      if (read === "recognizable") {
        readScheduledTaskCommandMock.mockImplementationOnce(async (_env, options) => {
          options?.onLauncherContent?.(
            "@echo off\r\nnode C:\\openclaw\\dist\\entry.js gateway run\r\n",
            "C:\\fixtures\\service.cmd",
          );
          throw new Error("Nested launcher could not be read");
        });
      }
      const env = { ...nativeEnv, OPENCLAW_WINDOWS_TASK_NAME: selected };
      const result = projection
        ? await findExtraGatewayServices(env, { deep: true })
        : await listManagedOpenClawGatewayServices(env, { requireComplete: true });
      expect(result).toEqual({
        services: [],
        errors: sources.map((source) => ({
          source,
          message: exact
            ? "Scheduled Task launcher could not be inspected."
            : expect.stringContaining(message ?? "could not be inspected"),
        })),
      });
      expect(renderGatewayServiceCleanupHints(result.services)).toEqual([]);
      if (projection === "both") {
        expect(await listManagedOpenClawGatewayServices(env)).toEqual(result);
      }
    },
  );
  it.each(["absolute script", "relative script", "direct executable"] as const)(
    "keeps a modern Gateway beneath a legacy-named parent (%s)",
    async (entryKind) => {
      const root = path.join(
        tempDirs.make("managed-windows-identity-", os.tmpdir()),
        "clawdbot",
        "openclaw",
      );
      const entry = path.join(root, "dist", "entry.js");
      const executable = path.join(root, "openclaw.exe");
      await fs.mkdir(path.dirname(entry), { recursive: true });
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
      await fs.writeFile(entry, "export {};\n");
      await fs.writeFile(executable, "synthetic executable bytes; never launched\n");
      const script = entryKind === "relative script" ? path.join("dist", "entry.js") : entry;
      const labels = ["\\OpenClaw Gateway (dev)", "\\Custom Modern"];
      listScheduledTasksMock.mockReturnValue(
        labels.map((label) => ({
          taskPath: label,
          state: 4,
          actions: [
            {
              type: 0,
              path: entryKind === "direct executable" ? executable : process.execPath,
              arguments:
                entryKind === "direct executable" ? "gateway run" : `"${script}" gateway run`,
              workingDirectory: root,
            },
          ],
        })),
      );

      const managed = await listManagedOpenClawGatewayServices(nativeEnv);

      expect(managed).toEqual({
        services: labels.map((label) =>
          expect.objectContaining({ label, marker: "openclaw", legacy: false }),
        ),
        errors: [],
      });
      await expect(findExtraGatewayServices(nativeEnv, { deep: true })).resolves.toEqual({
        services: [
          expect.objectContaining({ label: "\\Custom Modern", marker: "openclaw", legacy: false }),
        ],
        errors: [],
      });
      expect(await fs.readFile(entry, "utf8")).toBe("export {};\n");
    },
  );
});
