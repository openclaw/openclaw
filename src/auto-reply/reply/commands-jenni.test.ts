import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildJenniExecCommand, handleJenniCommand } from "./commands-jenni.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const executeTrackedChatCommandMock = vi.hoisted(() =>
  vi.fn(async () => ({ text: "🧪 Jenni job started (inspect, session sess-1)." })),
);

vi.mock("./bash-command.js", () => ({
  executeTrackedChatCommand: executeTrackedChatCommandMock,
}));

describe("handleJenniCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes /jenni inspect through the tracked exec flow", async () => {
    const cfg = {
      commands: { text: true, bash: true },
      whatsapp: { allowFrom: ["*"] },
    } as OpenClawConfig;
    const params = buildCommandTestParams("/jenni inspect", cfg, undefined, {
      workspaceDir: "/tmp/openclaw",
    });

    const result = await handleJenniCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Jenni job started");
    expect(executeTrackedChatCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        commandText: ".venv/bin/python3 -m app.bridge --spec app/jobs/host_inspection.yaml",
        displayLabel: "jenni",
        workdir: expect.stringMatching(/jenni-admin$/),
      }),
    );
  });

  it("routes /jenni benchmark through the fixed benchmark spec", async () => {
    const cfg = {
      commands: { text: true, bash: true },
      whatsapp: { allowFrom: ["*"] },
    } as OpenClawConfig;
    const params = buildCommandTestParams("/jenni benchmark", cfg);

    await handleJenniCommand(params, true);

    expect(executeTrackedChatCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        commandText: ".venv/bin/python3 -m app.bridge --spec app/jobs/benchmark_basic.yaml",
      }),
    );
  });

  it("returns usage text for /jenni without a subcommand", async () => {
    const cfg = {
      commands: { text: true, bash: true },
      whatsapp: { allowFrom: ["*"] },
    } as OpenClawConfig;
    const params = buildCommandTestParams("/jenni", cfg);

    const result = await handleJenniCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: ["🧪 Usage:", "- /jenni inspect", "- /jenni benchmark"].join("\n"),
      },
    });
    expect(executeTrackedChatCommandMock).not.toHaveBeenCalled();
  });

  it("returns a bounded error for unknown Jenni subcommands", async () => {
    const cfg = {
      commands: { text: true, bash: true },
      whatsapp: { allowFrom: ["*"] },
    } as OpenClawConfig;
    const params = buildCommandTestParams("/jenni nope", cfg);

    const result = await handleJenniCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: [
          "⚠️ Unknown Jenni job: nope",
          "🧪 Usage:",
          "- /jenni inspect",
          "- /jenni benchmark",
        ].join("\n"),
      },
    });
    expect(executeTrackedChatCommandMock).not.toHaveBeenCalled();
  });
});

describe("buildJenniExecCommand", () => {
  it("builds the fixed inspect and benchmark commands", () => {
    expect(buildJenniExecCommand("inspect")).toBe(
      ".venv/bin/python3 -m app.bridge --spec app/jobs/host_inspection.yaml",
    );
    expect(buildJenniExecCommand("benchmark")).toBe(
      ".venv/bin/python3 -m app.bridge --spec app/jobs/benchmark_basic.yaml",
    );
  });
});
