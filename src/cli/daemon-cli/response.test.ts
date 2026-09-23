// Daemon response tests cover normalized daemon command response shapes.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayService } from "../../daemon/service.js";
import { defaultRuntime } from "../../runtime.js";
import { createDaemonActionContext, installDaemonServiceAndEmit } from "./response.js";

describe("daemon action JSON hints", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("classifies common daemon hint kinds", () => {
    const hints = [
      "openclaw gateway install",
      "Restart the container or the service that manages it for openclaw-demo-container.",
      "systemd user services are unavailable; install/enable systemd or run the gateway under your supervisor.",
      "On a headless server (SSH/no desktop session): run `sudo loginctl enable-linger $(whoami)` to persist your systemd user session across logins.",
      "If you're in a container, run the gateway in the foreground instead of `openclaw gateway`.",
      "WSL2 needs systemd enabled: edit /etc/wsl.conf with [boot]\\nsystemd=true",
    ];
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});

    createDaemonActionContext({ action: "install", json: true }).emit({ ok: false, hints });

    expect(writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "install",
        hints,
        hintItems: [
          { kind: "install", text: "openclaw gateway install" },
          {
            kind: "container-restart",
            text: "Restart the container or the service that manages it for openclaw-demo-container.",
          },
          {
            kind: "systemd-unavailable",
            text: "systemd user services are unavailable; install/enable systemd or run the gateway under your supervisor.",
          },
          {
            kind: "systemd-headless",
            text: "On a headless server (SSH/no desktop session): run `sudo loginctl enable-linger $(whoami)` to persist your systemd user session across logins.",
          },
          {
            kind: "container-foreground",
            text: "If you're in a container, run the gateway in the foreground instead of `openclaw gateway`.",
          },
          {
            kind: "wsl-systemd",
            text: "WSL2 needs systemd enabled: edit /etc/wsl.conf with [boot]\\nsystemd=true",
          },
        ],
      }),
    );
  });

  it.each([
    "openclaw --profile work gateway install",
    "openclaw --container demo gateway install",
    "openclaw node install",
    "openclaw --profile work node install",
    "openclaw --container demo node install",
  ])("classifies scoped Gateway and node service install hints: %s", (hint) => {
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});

    createDaemonActionContext({ action: "start", json: true }).emit({ ok: false, hints: [hint] });

    expect(writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ hintItems: [{ kind: "install", text: hint }] }),
    );
  });
});

describe("daemon install verification", () => {
  function createInstallParams(
    isLoaded: GatewayService["isLoaded"],
    onVerified?: () => Promise<void>,
  ) {
    const service = {
      label: "systemd user",
      loadedText: "enabled",
      notLoadedText: "disabled",
      isLoaded,
    } as GatewayService;
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

  it("fails install when service-manager verification throws", async () => {
    const params = createInstallParams(
      vi.fn(async () => {
        throw new Error("manager access denied");
      }),
    );

    await installDaemonServiceAndEmit(params);

    expect(params.fail).toHaveBeenCalledWith(
      "Gateway install verification failed: Error: manager access denied",
      undefined,
    );
    expect(params.emit).not.toHaveBeenCalled();
  });

  it("fails install when the service is not loaded after installation", async () => {
    const params = createInstallParams(vi.fn(async () => false));

    await installDaemonServiceAndEmit(params);

    expect(params.fail).toHaveBeenCalledWith(
      "Gateway install verification failed: service is not enabled.",
    );
    expect(params.emit).not.toHaveBeenCalled();
  });

  it("reports registration separately from readiness for a still-starting service", async () => {
    const params = {
      ...createInstallParams(vi.fn(async () => true)),
      successMessage:
        "Gateway service installed. Runtime readiness has not been checked; startup may still be in progress.",
    };
    await installDaemonServiceAndEmit(params);
    expect(params.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        result: "installed",
        message: params.successMessage,
      }),
    );
  });

  it("emits success only after the service-manager verification succeeds", async () => {
    const params = createInstallParams(vi.fn(async () => true));

    await installDaemonServiceAndEmit(params);

    expect(params.fail).not.toHaveBeenCalled();
    expect(params.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        result: "installed",
        service: expect.objectContaining({ loaded: true }),
      }),
    );
  });

  it("runs onVerified after verification succeeds and before the success emit", async () => {
    const onVerified = vi.fn(async () => {});
    const params = createInstallParams(
      vi.fn(async () => true),
      onVerified,
    );

    await installDaemonServiceAndEmit(params);

    expect(onVerified).toHaveBeenCalledTimes(1);
    expect(params.fail).not.toHaveBeenCalled();
    expect(params.emit).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, result: "installed" }),
    );
  });

  it("fails with no success emit when onVerified throws", async () => {
    const params = createInstallParams(
      vi.fn(async () => true),
      async () => {
        throw new Error("post-check boom");
      },
    );

    await installDaemonServiceAndEmit(params);

    expect(params.fail).toHaveBeenCalledWith(
      "Gateway post-install check failed: Error: post-check boom",
    );
    expect(params.emit).not.toHaveBeenCalled();
  });
});

describe("daemon output contract", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])("keeps emit JSON-only even with a message (json=%s)", (json) => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    const context = createDaemonActionContext({ action: "install", json });
    context.warnings.push("", "repeat", "repeat");

    context.emit({ ok: true, message: "machine-only detail" });

    expect(log).not.toHaveBeenCalled();
    expect(writeJson.mock.calls).toEqual(
      json
        ? [
            [
              {
                action: "install",
                ok: true,
                message: "machine-only detail",
                hintItems: undefined,
                warnings: ["", "repeat", "repeat"],
              },
            ],
          ]
        : [],
    );
    expect(context.warnings).toEqual(["", "repeat", "repeat"]);
  });

  it.each([false, true])("emits failure and ordered hints before exit (json=%s)", (json) => {
    const events: unknown[][] = [];
    const failure = new Error("fixture exit");
    vi.spyOn(defaultRuntime, "log").mockImplementation((...args) => {
      events.push(["log", ...args]);
    });
    vi.spyOn(defaultRuntime, "error").mockImplementation((...args) => {
      events.push(["error", ...args]);
    });
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => {
      events.push(["json", value]);
    });
    vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
      events.push(["exit", code]);
      throw failure;
    });
    const context = createDaemonActionContext({ action: "restart", json });
    context.warnings.push("first", "", "first");

    expect(() =>
      context.fail("not healthy", ["inspect", "retry"], "restart-health-failed"),
    ).toThrow(failure);

    expect(events).toEqual(
      json
        ? [
            [
              "json",
              {
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
              },
            ],
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
});
