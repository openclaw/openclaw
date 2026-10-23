import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayService } from "../../daemon/service.js";
import { defaultRuntime } from "../../runtime.js";
import { createDaemonActionContext, installDaemonServiceAndEmit } from "./response.js";

afterEach(() => vi.restoreAllMocks());

describe("daemon output contract", () => {
  it.each([false, true])("emits classified hints and warnings only as JSON (json=%s)", (json) => {
    const hints = [
      "openclaw gateway install",
      "openclaw --profile work gateway install",
      "openclaw --container demo node install",
      "Restart the container or the service that manages it for openclaw-demo-container.",
      "systemd user services are unavailable; install/enable systemd or run the gateway under your supervisor.",
      "On a headless server (SSH/no desktop session): run `sudo loginctl enable-linger $(whoami)` to persist your systemd user session across logins.",
      "If you're in a container, run the gateway in the foreground instead of `openclaw gateway`.",
      "WSL2 needs systemd enabled: edit /etc/wsl.conf with [boot]\\nsystemd=true",
    ];
    const kinds = [
      "install",
      "install",
      "install",
      "container-restart",
      "systemd-unavailable",
      "systemd-headless",
      "container-foreground",
      "wsl-systemd",
    ];
    const hintItems = hints.map((text, index) => ({ kind: kinds[index], text }));
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    const context = createDaemonActionContext({ action: "install", json });
    context.warnings.push("", "repeat", "repeat");

    context.emit({ ok: true, message: "machine-only detail", hints });

    expect(log).not.toHaveBeenCalled();
    expect(writeJson.mock.calls).toEqual(
      json
        ? [
            [
              {
                action: "install",
                ok: true,
                message: "machine-only detail",
                hints,
                hintItems,
                warnings: ["", "repeat", "repeat"],
              },
            ],
          ]
        : [],
    );
    expect(context.warnings).toEqual(["", "repeat", "repeat"]);
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

  it.each([
    {
      failure: "manager",
      message: "Gateway install verification failed: Error: manager access denied",
    },
    {
      failure: "not loaded",
      message: "Gateway install verification failed: service is not enabled.",
    },
    { failure: "post-check", message: "Gateway post-install check failed: Error: post-check boom" },
  ])("does not emit success after $failure failure", async ({ failure, message }) => {
    const params = createInstallParams(
      vi.fn(async () => {
        if (failure === "manager") {
          throw new Error("manager access denied");
        }
        return failure !== "not loaded";
      }),
      failure === "post-check"
        ? async () => {
            throw new Error("post-check boom");
          }
        : undefined,
    );
    await installDaemonServiceAndEmit(params);
    expect(params.fail).toHaveBeenCalledWith(
      ...(failure === "manager" ? [message, undefined] : [message]),
    );
    expect(params.emit).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "emits verified registration with optional post-check (postCheck=%s)",
    async (postCheck) => {
      const onVerified = vi.fn(async () => {});
      const params = {
        ...createInstallParams(
          vi.fn(async () => true),
          postCheck ? onVerified : undefined,
        ),
        successMessage: postCheck
          ? "Gateway service installed. Runtime readiness has not been checked; startup may still be in progress."
          : undefined,
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
});

describe("daemon output contract", () => {
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
