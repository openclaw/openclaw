import { beforeEach, describe, expect, it, vi } from "vitest";
const exec = vi.hoisted(() => vi.fn<typeof import("./exec-file.js").execFileUtf8>());
vi.mock("./exec-file.js", async (original) => ({
  ...(await original<typeof import("./exec-file.js")>()),
  execFileUtf8: exec,
}));
import { createSystemdBusctlQuery } from "./systemd-busctl-query.js";
import { nativeExit } from "./systemd-exec.test-support.js";

const unit = "openclaw-gateway.service";
const manager = [
  "call",
  "org.freedesktop.systemd1",
  "/org/freedesktop/systemd1",
  "org.freedesktop.systemd1.Manager",
];
// systemd 245 busctl colors its "Call failed" line even when stderr is a pipe.
const colored = (detail: string) => `\u001b[0;1;31m${detail}\u001b[0m\n`;

function query() {
  return createSystemdBusctlQuery({
    env: {},
    scope: "system",
    deadline: performance.now() + 60_000,
    calls: 1,
    boundCalls: false,
    noAutoStart: true,
    unavailable: () => new Error("unavailable"),
  });
}

describe("createSystemdBusctlQuery", () => {
  beforeEach(() => exec.mockReset());

  it.each([
    ["GetUnit", `Call failed: Unit ${unit} not loaded.`],
    ["GetUnitFileState", "Call failed: No such file or directory"],
  ])("treats colored %s stderr %j as a missing unit", async (method, detail) => {
    exec.mockResolvedValue(nativeExit("", colored(detail), 1));
    await expect(query()([...manager, method, "s", unit], ["o"])).resolves.toBeNull();
  });

  it.each([
    ["GetUnit", `Unit ${unit} not loaded.`],
    ["GetUnit", `Unit ${unit} not found.`],
    ["LoadUnit", `Unit ${unit} not found.`],
    ["GetUnitFileState", "No such file or directory"],
    ["GetUnitFileState", `Unit file ${unit} does not exist.`],
  ])("treats systemd 239 unprefixed %s stderr %j as a missing unit", async (method, detail) => {
    exec.mockResolvedValue(nativeExit("", `${detail}\n`, 1));
    await expect(query()([...manager, method, "s", unit], ["o"])).resolves.toBeNull();
  });

  it("treats colored unprefixed missing-unit replies as missing", async () => {
    exec.mockResolvedValue(nativeExit("", colored(`Unit ${unit} not loaded.`), 1));
    await expect(query()([...manager, "GetUnit", "s", unit], ["o"])).resolves.toBeNull();
  });

  it("still rejects unrelated unprefixed failures", async () => {
    exec.mockResolvedValue(nativeExit("", "Access denied\n", 1));
    await expect(query()([...manager, "GetUnit", "s", unit], ["o"])).rejects.toThrow();
  });

  it("still rejects unrelated colored failures", async () => {
    exec.mockResolvedValue(nativeExit("", colored("Call failed: Access denied"), 1));
    await expect(query()([...manager, "GetUnit", "s", unit], ["o"])).rejects.toThrow();
  });
});
