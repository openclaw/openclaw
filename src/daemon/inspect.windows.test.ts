import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { findExtraGatewayServices, renderGatewayServiceCleanupHints } from "./inspect.js";

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
  const task = (taskPath: string, executable: string, args: string) => ({
    taskPath,
    state: null,
    actions: [{ type: 0, path: executable, arguments: args, workingDirectory: "" }],
  });

  beforeEach(() => {
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

    const result = await findExtraGatewayServices({}, { deep: true });

    expect(result).toEqual({
      services: [],
      errors: [{ source: "schtasks", message: expect.stringContaining("could not be queried") }],
    });
    expect(renderGatewayServiceCleanupHints(result.services)).toEqual([]);
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

    const result = await findExtraGatewayServices({}, { deep: true });

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
    for (const service of result.services) {
      expect(service).not.toHaveProperty("extra");
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

      const result = await findExtraGatewayServices({}, { deep: true });

      expect(result.errors).toEqual([]);
      expect(result.services).toEqual([
        expect.objectContaining({ label: "\\Custom Service", marker: "openclaw", legacy: false }),
      ]);
    },
  );

  it.each([{ actions: undefined }, { actions: [] }])(
    "retains incomplete known selectors with missing actions $actions",
    async ({ actions }) => {
      listScheduledTasksMock.mockReturnValue([
        { taskPath: "\\OpenClaw Gateway", state: null, actions },
        { taskPath: "\\Selected Custom", state: null, actions },
      ]);
      const env = { OPENCLAW_WINDOWS_TASK_NAME: "\\Selected Custom" };

      const extras = await findExtraGatewayServices(env, { deep: true });

      expect(extras.services).toEqual([]);
      expect(extras.errors).toEqual([
        {
          source: "\\OpenClaw Gateway",
          message: expect.stringContaining("could not be inspected"),
        },
        { source: "\\Selected Custom", message: expect.stringContaining("could not be inspected") },
      ]);
    },
  );

  it.each([
    ["modern Gateway", "Services\\Selected Gateway", "openclaw", "gateway run", false],
    ["legacy command", "Services\\Selected Legacy", "clawdbot", "run", true],
    ["upgraded legacy task", "Clawdbot Gateway", "openclaw", "gateway run", true],
    ["Node", "Services\\Selected Node", "openclaw", "node run", true],
    ["canonical modern Gateway", "OpenClaw Gateway", "openclaw", "gateway run", false],
    ["canonical legacy command", "OpenClaw Gateway", "clawdbot", "run", true],
    ["profile-named Node", "OpenClaw Gateway (dev)", "openclaw", "node run", true],
  ] as const)(
    "keeps selected %s diagnostics while excluding the current modern Gateway",
    async (_kind, name, marker, args, extra) => {
      const label = `\\${name}`;
      listScheduledTasksMock.mockReturnValue([task(label, `C:\\${marker}\\${marker}.exe`, args)]);
      const extras = await findExtraGatewayServices(
        { OPENCLAW_WINDOWS_TASK_NAME: name },
        { deep: true },
      );
      expect(extras.errors).toEqual([]);
      expect(extras.services).toEqual(extra ? [expect.objectContaining({ label, marker })] : []);
      expect(renderGatewayServiceCleanupHints(extras.services)).toEqual(
        extra ? [`schtasks /Query /TN "${label}" /V /FO LIST`] : [],
      );
    },
  );

  it.each(["\\OpenClaw Gateway (dev)", "\\Clawdbot Gateway"])(
    "reports unreadable known launcher %s before any contents are available",
    async (label) => {
      listScheduledTasksMock.mockReturnValue([task(label, "C:\\custom\\gateway.cmd", "")]);
      readScheduledTaskCommandMock.mockRejectedValue(new Error("Access denied"));

      const result = await findExtraGatewayServices({}, { deep: true });

      expect(result).toEqual({
        services: [],
        errors: [{ source: label, message: "Scheduled Task launcher could not be inspected." }],
      });
      expect(renderGatewayServiceCleanupHints(result.services)).toEqual([]);
    },
  );

  it.each(["absolute script", "relative script", "direct executable"] as const)(
    "keeps a modern Gateway beneath a legacy-named parent (%s)",
    async (entryKind) => {
      const root = path.join(tempDirs.make("windows-package-identity-"), "clawdbot", "openclaw");
      const entry = path.join(root, "dist", "entry.js");
      const executable = path.join(root, "openclaw.exe");
      await fs.mkdir(path.dirname(entry), { recursive: true });
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
      await fs.writeFile(entry, "export {};\n");
      await fs.writeFile(executable, "synthetic executable bytes; never launched\n");
      const script = entryKind === "relative script" ? path.join("dist", "entry.js") : entry;
      const label = "\\Custom Modern";
      listScheduledTasksMock.mockReturnValue([
        {
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
        },
      ]);
      await expect(findExtraGatewayServices({}, { deep: true })).resolves.toEqual({
        services: [expect.objectContaining({ label, marker: "openclaw", legacy: false })],
        errors: [],
      });
      expect(await fs.readFile(entry, "utf8")).toBe("export {};\n");
    },
  );

  it("reports a recognizable launcher read failure without offering its deletion", async () => {
    listScheduledTasksMock.mockReturnValue([
      task("\\Custom Service", "C:\\fixtures\\service.cmd", ""),
    ]);
    readScheduledTaskCommandMock.mockImplementationOnce(async (_env, options) => {
      options?.onLauncherContent?.(
        "@echo off\r\nnode C:\\openclaw\\dist\\entry.js gateway run\r\n",
      );
      throw new Error("Nested launcher could not be read");
    });

    const result = await findExtraGatewayServices({}, { deep: true });

    expect(result).toEqual({
      services: [],
      errors: [
        { source: "\\Custom Service", message: expect.stringContaining("could not be inspected") },
      ],
    });
    expect(renderGatewayServiceCleanupHints(result.services)).toEqual([]);
  });
});
