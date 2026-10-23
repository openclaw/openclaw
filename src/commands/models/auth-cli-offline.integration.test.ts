import "./auth.js";
import "./auth-logout.js";
import "./auth-order.js";
import fs from "node:fs/promises";
import { CANCEL_SYMBOL } from "@clack/prompts";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../../agents/auth-profiles/store-runtime.js";
import { registerModelsCli } from "../../cli/models-cli.js";
import { captureGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

const mocks = vi.hoisted(() => ({ password: vi.fn() }));
vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  password: mocks.password,
}));
// mock-isolation: An offline command must not contact an operator's running Gateway.
vi.mock("./auth-refresh.js", () => ({
  refreshRunningGatewayAuthState: async () => "unavailable",
}));

afterEach(() => vi.restoreAllMocks());

it("keeps offline custody through credential input, writes, order changes, and removal", async () => {
  await withOpenClawTestState({ label: "models-auth-offline" }, async (state) => {
    await state.writeConfig({
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      plugins: { enabled: false },
    });
    const databasePath = state.statePath("state", "openclaw.sqlite");
    const profileId = "synthetic:manual";
    mocks.password.mockImplementation(async () => {
      expect(captureGatewayStateOwner(databasePath)?.role).toBe("agent-embedded");
      return "synthetic-provider-key";
    });
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
      throw new ExitError(code, errors.mock.calls.flat().join("\n"));
    });
    const run = async (args: string[]) => {
      const program = new Command().enablePositionalOptions();
      registerModelsCli(program);
      await program.parseAsync(["models", "auth", ...args], { from: "user" });
      expect(captureGatewayStateOwner(databasePath)).toBeUndefined();
    };
    const readStore = () => loadAuthProfileStoreWithoutExternalProfiles(state.agentDir());
    try {
      await run(["paste-api-key", "--provider", "synthetic"]);
      expect(readStore().profiles[profileId]).toMatchObject({
        type: "api_key",
        provider: "synthetic",
        key: "synthetic-provider-key",
      });

      mocks.password.mockResolvedValueOnce(CANCEL_SYMBOL);
      await expect(run(["paste-api-key", "--provider", "synthetic"])).rejects.toMatchObject({
        name: "ExitError",
        code: 0,
      });
      expect(captureGatewayStateOwner(databasePath)).toBeUndefined();
      expect(readStore().profiles[profileId]).toMatchObject({ key: "synthetic-provider-key" });

      await run(["order", "set", "--provider", "synthetic", profileId]);
      expect(readStore().order?.synthetic).toEqual([profileId]);
      await run(["order", "clear", "--provider", "synthetic"]);
      expect(readStore().order?.synthetic).toBeUndefined();

      await run(["logout", profileId, "--yes"]);
      expect(readStore().profiles[profileId]).toBeUndefined();
      const saved = JSON.parse(await fs.readFile(state.configPath, "utf8"));
      expect(saved.auth?.profiles?.[profileId]).toBeUndefined();
      expect(defaultRuntime.log).toHaveBeenCalledWith(
        "Removed auth profile: synthetic:manual (synthetic/api_key)",
      );
    } finally {
      if (ttyDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", ttyDescriptor);
      } else {
        Reflect.deleteProperty(process.stdin, "isTTY");
      }
    }
  });
});
