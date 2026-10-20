import { afterEach, expect, it, vi } from "vitest";
import type { GatewayService } from "../../daemon/service.js";
import { defaultRuntime } from "../../runtime.js";
import { createDaemonActionContext, installDaemonServiceAndEmit } from "./response.js";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])("emits classified hints and warnings only as JSON (json=%s)", (json) => {
  const hintItems = [
    ["install", "openclaw gateway install"],
    ["install", "openclaw --profile work gateway install"],
    ["install", "openclaw --container demo node install"],
    ["container-restart", "Restart the container or the service that manages it for fixture."],
    ["systemd-unavailable", "systemd user services are unavailable; fixture"],
    ["systemd-headless", "On a headless server (SSH/no desktop session): fixture"],
    [
      "container-foreground",
      "If you're in a container, run the gateway in the foreground instead of fixture",
    ],
    ["wsl-systemd", "WSL2 needs systemd enabled: fixture"],
  ].map(([kind, text]) => ({ kind, text }));
  const hints = hintItems.map(({ text }) => text);
  const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  const context = createDaemonActionContext({ action: "install", json });
  context.warnings.push("", "repeat", "repeat");
  context.emit({ ok: true, message: "machine-only detail", hints });
  const payload = {
    action: "install",
    ok: true,
    message: "machine-only detail",
    hints,
    hintItems,
    warnings: ["", "repeat", "repeat"],
  };
  expect(log).not.toHaveBeenCalled();
  expect(writeJson.mock.calls).toEqual(json ? [[payload]] : []);
  expect(context.warnings).toEqual(["", "repeat", "repeat"]);
});

function createInstallParams(
  isLoaded: GatewayService["isLoaded"],
  onVerified?: () => Promise<void>,
) {
  const service = { loadedText: "enabled", isLoaded } as GatewayService;
  return {
    serviceNoun: "Gateway",
    service,
    warnings: [],
    emit: vi.fn(),
    fail: vi.fn(),
    install: vi.fn(async () => {}),
    onVerified,
  };
}

function reject(message: string) {
  return async () => {
    throw new Error(message);
  };
}

it.each([
  ["manager", "Gateway install verification failed: Error: manager access denied"],
  ["not loaded", "Gateway install verification failed: service is not enabled."],
  ["post-check", "Gateway post-install check failed: Error: post-check boom"],
])("does not emit success after %s failure", async (failure, message) => {
  const params = createInstallParams(
    failure === "manager" ? reject("manager access denied") : async () => failure !== "not loaded",
    failure === "post-check" ? reject("post-check boom") : undefined,
  );
  await installDaemonServiceAndEmit(params);
  expect(params.fail).toHaveBeenCalledWith(
    ...(failure === "manager" ? [message, undefined] : [message]),
  );
  expect(params.emit).not.toHaveBeenCalled();
});

it.each([false, true])(
  "emits verified registration with optional post-check (%s)",
  async (postCheck) => {
    const onVerified = vi.fn(async () => {});
    const params = {
      ...createInstallParams(async () => true, postCheck ? onVerified : undefined),
      successMessage: postCheck ? "Registered; runtime readiness not checked." : undefined,
    };
    await installDaemonServiceAndEmit(params);
    expect(onVerified).toHaveBeenCalledTimes(postCheck ? 1 : 0);
    expect(params.fail).not.toHaveBeenCalled();
    expect(params.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        result: "installed",
        service: expect.objectContaining({ loaded: true }),
        ...(postCheck ? { message: params.successMessage } : {}),
      }),
    );
  },
);

it.each([false, true])("emits failure and ordered hints before exit (json=%s)", (json) => {
  const events: unknown[][] = [];
  const failure = new Error("fixture exit");
  for (const method of ["log", "error", "writeJson"] as const) {
    vi.spyOn(defaultRuntime, method).mockImplementation((...args: unknown[]) => {
      events.push([method === "writeJson" ? "json" : method, ...args]);
    });
  }
  vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
    events.push(["exit", code]);
    throw failure;
  });
  const context = createDaemonActionContext({ action: "restart", json });
  context.warnings.push("first", "", "first");
  expect(() => context.fail("not healthy", ["inspect", "retry"], "restart-health-failed")).toThrow(
    failure,
  );
  const payload = {
    action: "restart",
    ok: false,
    error: "not healthy",
    hints: ["inspect", "retry"],
    result: "restart-health-failed",
    hintItems: [
      { kind: "generic", text: "inspect" },
      { kind: "generic", text: "retry" },
    ],
    warnings: ["first", "", "first"],
  };
  expect(events).toEqual(
    json
      ? [
          ["json", payload],
          ["exit", 1],
        ]
      : [
          ["error", "not healthy"],
          ["log", "Tip: inspect"],
          ["log", "Tip: retry"],
          ["exit", 1],
        ],
  );
});
