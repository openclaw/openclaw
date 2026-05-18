import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatCliCommand } from "../cli/command-format.js";
import type { RuntimeEnv } from "../runtime.js";
import { CONFIGURE_WIZARD_SECTIONS } from "./configure.shared.js";

const mocks = vi.hoisted(() => ({
  runConfigureWizard: vi.fn(async () => {}),
}));

vi.mock("./configure.wizard.js", () => ({
  runConfigureWizard: mocks.runConfigureWizard,
}));

import { configureCommandFromSectionsArg } from "./configure.commands.js";

function makeRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as unknown as RuntimeEnv["exit"],
  };
}

describe("configureCommandFromSectionsArg", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs the full configure wizard when no sections are provided", async () => {
    const runtime = makeRuntime();

    await configureCommandFromSectionsArg(undefined, runtime);

    expect(mocks.runConfigureWizard).toHaveBeenCalledWith({ command: "configure" }, runtime);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("runs only the requested valid sections", async () => {
    const runtime = makeRuntime();

    await configureCommandFromSectionsArg(["gateway", "model"], runtime);

    expect(mocks.runConfigureWizard).toHaveBeenCalledWith(
      { command: "configure", sections: ["gateway", "model"] },
      runtime,
    );
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("rejects invalid-only section input instead of falling back to the full wizard", async () => {
    const runtime = makeRuntime();

    await configureCommandFromSectionsArg(["typo"], runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      `Invalid --section: typo. Expected one of: ${CONFIGURE_WIZARD_SECTIONS.join(", ")}. Run ${formatCliCommand("openclaw configure")} without --section to use the full wizard.`,
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.runConfigureWizard).not.toHaveBeenCalled();
  });

  it("rejects mixed valid and invalid section input without running a partial wizard", async () => {
    const runtime = makeRuntime();

    await configureCommandFromSectionsArg(["gateway", "bogus"], runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      `Invalid --section: bogus. Expected one of: ${CONFIGURE_WIZARD_SECTIONS.join(", ")}. Run ${formatCliCommand("openclaw configure")} without --section to use the full wizard.`,
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.runConfigureWizard).not.toHaveBeenCalled();
  });
});
