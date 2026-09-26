import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandWithRuntime } from "../cli/cli-utils.js";
import { formatCliJsonFailure } from "../cli/failure-output.js";
import {
  applyResolvedCommandOutputMode,
  withConsoleLogsRoutedToStderrForJson,
} from "../cli/json-output-mode.js";
import { agentCliCommand } from "./agent-via-gateway.js";

const { callGateway, agentCommand } = vi.hoisted(() => ({
  callGateway: vi.fn(),
  agentCommand: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway,
  isGatewayCredentialsRequiredError: vi.fn(),
  isGatewayExplicitAuthRequiredError: vi.fn(),
  isGatewayTransportError: vi.fn(),
  randomIdempotencyKey: () => "idem-1",
}));
vi.mock("./agent.js", () => ({ agentCommand }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
const compactGuidance =
  "Slash commands cannot be executed via --message from the CLI. Use: openclaw sessions compact <key>";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  expect(callGateway).not.toHaveBeenCalled();
  expect(agentCommand).not.toHaveBeenCalled();
  expect(runtime.error).not.toHaveBeenCalled();
  expect(runtime.exit).not.toHaveBeenCalled();
});

describe("agent CLI compact rejection", () => {
  it.each(["  /CoMpAcT  ", "/compact Keep recent decisions."])(
    "rejects %j before any gateway or embedded turn",
    async (message) => {
      await expect(
        agentCliCommand({ message, sessionKey: "agent:main:main" }, runtime),
      ).rejects.toThrow(compactGuidance);
    },
  );

  it("rejects /compact from --message-file before any gateway or embedded turn", async () => {
    const messageFile = path.join(tempDirs.make("openclaw-compact-"), "compact.md");
    fs.writeFileSync(messageFile, "/compact:Keep recent decisions.", "utf8");

    await expect(
      agentCliCommand({ messageFile, sessionKey: "agent:main:main" }, runtime),
    ).rejects.toThrow(compactGuidance);
  });

  it("preserves the canonical JSON failure for a rejected /compact message", async () => {
    await withConsoleLogsRoutedToStderrForJson(["--json"], async () => {
      applyResolvedCommandOutputMode(true);
      const command = runCommandWithRuntime(runtime, async () => {
        await agentCliCommand(
          { message: "/compact", sessionKey: "agent:main:main", json: true },
          runtime,
        );
      });
      await expect(command).rejects.toThrow(compactGuidance);
      const error = await command.catch((caught: unknown) => caught);
      expect(formatCliJsonFailure(error, { env: {} })).toEqual({
        ok: false,
        error: { type: "cli_error", message: compactGuidance },
      });
    });
  });
});
