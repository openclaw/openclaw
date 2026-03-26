import { Command } from "commander";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const configureCommandFromSectionsArgMock = vi.fn();
const configureSurfaceCommandMock = vi.fn();
const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
  writeStdout: vi.fn(),
};

vi.mock("../../commands/configure.js", () => ({
  CONFIGURE_WIZARD_SECTIONS: ["auth", "channels", "gateway", "agent"],
  configureCommandFromSectionsArg: configureCommandFromSectionsArgMock,
}));

vi.mock("../../commands/configure-surface.js", () => ({
  configureSurfaceCommand: configureSurfaceCommandMock,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtime,
}));

const mockedModuleIds = [
  "../../commands/configure.js",
  "../../commands/configure-surface.js",
  "../../runtime.js",
];

let registerConfigureCommand: typeof import("./register.configure.js").registerConfigureCommand;

beforeAll(async () => {
  ({ registerConfigureCommand } = await import("./register.configure.js"));
});

afterAll(() => {
  for (const id of mockedModuleIds) {
    vi.doUnmock(id);
  }
  vi.resetModules();
});

describe("registerConfigureCommand", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerConfigureCommand(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    configureCommandFromSectionsArgMock.mockResolvedValue(undefined);
    configureSurfaceCommandMock.mockResolvedValue(undefined);
  });

  it("forwards repeated --section values", async () => {
    await runCli(["configure", "--section", "auth", "--section", "channels"]);

    expect(configureCommandFromSectionsArgMock).toHaveBeenCalledWith(["auth", "channels"], runtime);
  });

  it("reports errors through runtime when configure command fails", async () => {
    configureCommandFromSectionsArgMock.mockRejectedValueOnce(new Error("configure failed"));

    await runCli(["configure"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: configure failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("forwards configure surface options", async () => {
    await runCli([
      "configure",
      "surface",
      "--json-out",
      "/tmp/surface.json",
      "--section",
      "channels",
      "--installed-only",
    ]);

    expect(configureSurfaceCommandMock).toHaveBeenCalledWith({
      jsonOut: "/tmp/surface.json",
      section: ["channels"],
      installedOnly: true,
      runtime,
    });
  });

  it("does not inherit parent configure sections for surface export", async () => {
    await runCli([
      "configure",
      "--section",
      "gateway",
      "surface",
      "--json-out",
      "/tmp/surface.json",
    ]);

    expect(configureSurfaceCommandMock).toHaveBeenCalledWith({
      jsonOut: "/tmp/surface.json",
      section: [],
      installedOnly: false,
      runtime,
    });
  });

  it("does not anchor section parsing to json-out values named surface", async () => {
    await runCli(["configure", "surface", "--json-out", "surface", "--section", "channels"]);

    expect(configureSurfaceCommandMock).toHaveBeenCalledWith({
      jsonOut: "surface",
      section: ["channels"],
      installedOnly: false,
      runtime,
    });
  });
});
