import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatCliCommand } from "../cli/command-format.js";
import { configureCommandFromSectionsArg } from "./configure.commands.js";

const runConfigureWizardMock = vi.hoisted(() => vi.fn());

vi.mock("./configure.wizard.js", () => ({
  runConfigureWizard: runConfigureWizardMock,
}));

describe("configureCommandFromSectionsArg", () => {
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    runConfigureWizardMock.mockResolvedValue(undefined);
  });

  it("fails closed without an interactive tty", async () => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });

    try {
      await configureCommandFromSectionsArg(undefined, runtime);

      expect(runtime.error).toHaveBeenCalledWith(
        [
          "Configure needs an interactive TTY.",
          `Use \`${formatCliCommand("openclaw config get")}\`, \`${formatCliCommand("openclaw config set")}\`, \`${formatCliCommand("openclaw config patch")}\`, or \`${formatCliCommand("openclaw config validate")}\` for non-interactive config changes.`,
        ].join(" "),
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(runConfigureWizardMock).not.toHaveBeenCalled();
    } finally {
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      } else {
        Reflect.deleteProperty(process.stdin, "isTTY");
      }
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      } else {
        Reflect.deleteProperty(process.stdout, "isTTY");
      }
    }
  });

  it("runs the configure wizard when an interactive tty is available", async () => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });

    try {
      await configureCommandFromSectionsArg(["model"], runtime);

      expect(runConfigureWizardMock).toHaveBeenCalledWith(
        { command: "configure", sections: ["model"] },
        runtime,
      );
    } finally {
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      } else {
        Reflect.deleteProperty(process.stdin, "isTTY");
      }
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      } else {
        Reflect.deleteProperty(process.stdout, "isTTY");
      }
    }
  });
});
