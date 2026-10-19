import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

const originalPlatform = process.platform;
let nativeEnv: { APPDATA: string };
const action = (path: string, args: string) => ({
  type: 0,
  path,
  arguments: args,
  workingDirectory: "",
});
const task = (
  taskPath: string,
  executable: string | ReturnType<typeof action>[] = "C:\\OpenClaw\\openclaw.exe",
  args = "gateway run",
) => ({
  taskPath,
  state: null,
  actions: typeof executable === "string" ? [action(executable, args)] : executable,
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

it("inventories native and launcher-backed Node services without admitting a branded monitor", async () => {
  listScheduledTasksMock.mockReturnValue([
    task("\\OpenClaw Gateway"),
    task("\\OpenClaw Gateway (dev)", undefined, "gateway run --profile dev"),
    task("\\OpenClaw Gateway Backup"),
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
    task("\\OpenClaw CrossAction", [
      action("C:\\OpenClaw\\openclaw.exe", "node run"),
      action("C:\\tools\\helper.exe", "gateway run"),
    ]),
    task("\\Custom Service", "C:\\fixtures\\service.cmd", ""),
  ]);

  readScheduledTaskCommandMock.mockResolvedValue({
    programArguments: ["C:\\runtime\\node.exe", "C:\\app\\entry.js", "node", "run"],
    environment: { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "node" },
  });

  const result = await findExtraGatewayServices(nativeEnv, { deep: true });

  expect(result.errors).toEqual([]);
  expect(result.services).toEqual([
    expectedService("\\OpenClaw Gateway Backup"),
    expectedService("\\OpenClaw Node"),
    expectedService("\\Clawdbot Legacy", true),
    expectedService("\\OpenClaw CrossAction"),
    expectedService("\\Custom Service"),
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

const missingTasks = ["\\OpenClaw Gateway (dev)", "\\Clawdbot Gateway", "\\Custom Service"].map(
  (label) => task(label, "C:\\OpenClaw\\gateway.cmd", ""),
);
const knownTasks = ["\\OpenClaw Gateway", "\\Selected Custom"].map((taskPath) => ({
  taskPath,
  state: null,
  actions: undefined,
}));
const mixedTasks = [
  task("\\Mixed Assistant", [
    action("C:\\clawdbot\\clawdbot.exe", "run"),
    action("C:\\OpenClaw\\openclaw.exe", "gateway run"),
  ]),
];
it.each<[string, ScheduledTaskSnapshot[], string?, string?]>([
  ["missing actions", knownTasks, "\\Selected Custom"],
  ["missing launchers", missingTasks],
  ["multiple actions", mixedTasks, undefined, "Multiple Scheduled Task actions"],
])("qualifies incomplete inventory: %s", async (name, tasks, selected, message) => {
  listScheduledTasksMock.mockReturnValue(tasks);
  const missing = name === "missing launchers";
  if (missing) {
    readScheduledTaskCommandMock.mockResolvedValue(null);
  }
  const env = { ...nativeEnv, OPENCLAW_WINDOWS_TASK_NAME: selected };
  const result = selected
    ? await findExtraGatewayServices(env, { deep: true })
    : await listManagedOpenClawGatewayServices(env, { requireComplete: true });
  expect(result).toEqual({
    services: [],
    errors: tasks.map(({ taskPath: source }) => ({
      source,
      message: missing
        ? "Scheduled Task launcher could not be inspected."
        : expect.stringContaining(message ?? "could not be inspected"),
    })),
  });
  expect(renderGatewayServiceCleanupHints(result.services)).toEqual([]);
  if (selected) {
    expect(await listManagedOpenClawGatewayServices(env)).toEqual(result);
  }
});
