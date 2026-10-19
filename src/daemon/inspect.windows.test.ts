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
  const action = (path: string, args: string) => ({
    type: 0,
    path,
    arguments: args,
    workingDirectory: "",
  });
  const task = (taskPath: string, executable: string, args: string) => ({
    taskPath,
    state: null,
    actions: [action(executable, args)],
  });
  const expectedService = (label: string, legacy = false) =>
    expect.objectContaining({ label, marker: legacy ? "clawdbot" : "openclaw", legacy });

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
          action("C:\\OpenClaw\\openclaw.exe", "node run"),
          action("C:\\tools\\helper.exe", "gateway run"),
        ],
      },
    ]);

    const result = await findExtraGatewayServices(nativeEnv, { deep: true });

    expect(result.errors).toEqual([]);
    expect(result.services).toEqual([
      expectedService("\\OpenClaw Gateway Backup"),
      expectedService("\\OpenClaw Node"),
      expectedService("\\Clawdbot Legacy", true),
      expectedService("\\OpenClaw CrossAction"),
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

  it("recognizes verified node launcher metadata independently of the task label", async () => {
    listScheduledTasksMock.mockReturnValue([
      task("\\Custom Service", "C:\\fixtures\\service.cmd", ""),
    ]);
    readScheduledTaskCommandMock.mockResolvedValue({
      programArguments: ["C:\\runtime\\node.exe", "C:\\app\\entry.js", "node", "run"],
      environment: { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "node" },
    });

    const result = await findExtraGatewayServices(nativeEnv, { deep: true });

    expect(result.errors).toEqual([]);
    expect(result.services).toEqual([expectedService("\\Custom Service")]);
    expect(await listManagedOpenClawGatewayServices(nativeEnv)).toEqual({
      services: [],
      errors: [],
    });
  });

  type IncompleteCase = {
    name: string;
    tasks: ScheduledTaskSnapshot[];
    selected?: string;
    read?: "missing";
    projection?: "both";
    sources: string[];
    message?: string;
    exact?: boolean;
  };
  const knownLabels = ["\\OpenClaw Gateway (dev)", "\\Clawdbot Gateway"];
  const missingLabels = [...knownLabels, "\\Custom Service"];
  it.each<IncompleteCase>([
    {
      name: "known selectors with missing actions",
      tasks: ["\\OpenClaw Gateway", "\\Selected Custom"].map((taskPath) => ({
        taskPath,
        state: null,
        actions: undefined,
      })),
      selected: "\\Selected Custom",
      projection: "both",
      sources: ["\\OpenClaw Gateway", "\\Selected Custom"],
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
            action("C:\\clawdbot\\clawdbot.exe", "run"),
            action("C:\\OpenClaw\\openclaw.exe", "gateway run"),
          ],
        },
      ],
      sources: ["\\Mixed Assistant"],
      message: "Multiple Scheduled Task actions",
    },
  ])(
    "qualifies incomplete inventory: $name",
    async ({ tasks, selected, read, projection, sources, message, exact }) => {
      listScheduledTasksMock.mockReturnValue(tasks);
      if (read === "missing") {
        readScheduledTaskCommandMock.mockResolvedValue(null);
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
});
