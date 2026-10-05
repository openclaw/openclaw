import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { resolveCliCommandPathPolicy } from "./command-path-policy.js";

const planCommand = vi.hoisted(() => vi.fn());
vi.mock("./update-cli/plan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-cli/plan.js")>()),
  updateRecipePlanCommand: planCommand,
}));
// mock-isolation: Throw on mutable executor loading to prove passive planning never imports installed update execution.
vi.mock("./update-cli/update-command.js", () => {
  throw new Error("Passive planning must not import mutable execution");
});
// mock-isolation: Throw on plugin CLI loading to prove passive planning never activates the installed plugin graph.
vi.mock("../plugins/cli.js", () => {
  throw new Error("Passive planning must not activate plugins");
});
// mock-isolation: Throw on config preparation loading to prove passive dispatch precedes installed configuration admission.
vi.mock("./program/config-guard.js", () => {
  throw new Error("Passive planning must not run config preparation");
});

import {
  isPassiveUpdateInvocation,
  tryRunPassiveUpdateBeforeStartup,
} from "./run-main-passive-update.js";

const argv = (...args: string[]) => ["node", "openclaw", ...args];

beforeEach(() => {
  planCommand.mockReset();
  process.exitCode = undefined;
  vi.stubEnv("OPENCLAW_CONTAINER", "");
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("passive upgrade recipe entry", () => {
  it("uses the public command action without update execution or startup guards", async () => {
    const handled = await tryRunPassiveUpdateBeforeStartup(
      resolveCliArgvInvocation(
        argv(
          "update",
          "plan",
          "--installation",
          "/example",
          "--target",
          "exact-release",
          "--catalog",
          "/catalog.json",
          "--json",
        ),
      ),
    );
    expect(handled).toBe(true);
    expect(planCommand).toHaveBeenCalledExactlyOnceWith({
      installation: "/example",
      target: "exact-release",
      catalog: "/catalog.json",
      json: true,
    });
  });

  it("handles the root update alias before startup", async () => {
    await tryRunPassiveUpdateBeforeStartup(
      resolveCliArgvInvocation(argv("--update", "plan", "--json")),
    );
    expect(planCommand).toHaveBeenCalledExactlyOnceWith({
      installation: undefined,
      target: undefined,
      catalog: undefined,
      json: true,
    });
  });

  it("inherits parent JSON but refuses parent mutation selectors", async () => {
    await tryRunPassiveUpdateBeforeStartup(
      resolveCliArgvInvocation(argv("update", "--json", "plan")),
    );
    expect(planCommand).toHaveBeenCalledExactlyOnceWith({
      installation: undefined,
      target: undefined,
      catalog: undefined,
      json: true,
    });
    planCommand.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await tryRunPassiveUpdateBeforeStartup(
      resolveCliArgvInvocation(argv("update", "--tag", "latest", "plan", "--json")),
    );
    expect(planCommand).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("rejects a container selector rather than inspecting the wrong installation", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await tryRunPassiveUpdateBeforeStartup(
      resolveCliArgvInvocation(argv("--container", "other", "update", "plan")),
    );
    expect(planCommand).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it.each([
    ["update", "plan"],
    ["--update", "plan"],
  ])("rejects environment-selected containers before inspecting the host: %j", async (...args) => {
    vi.stubEnv("OPENCLAW_CONTAINER", "demo");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await tryRunPassiveUpdateBeforeStartup(resolveCliArgvInvocation(argv(...args)));
    expect(planCommand).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("container"));
  });

  it("does not intercept ordinary update or status, but keeps planning help passive", () => {
    for (const args of [["update"], ["update", "status"]]) {
      expect(isPassiveUpdateInvocation(resolveCliArgvInvocation(argv(...args)))).toBe(false);
    }
    expect(
      isPassiveUpdateInvocation(resolveCliArgvInvocation(argv("update", "plan", "--help"))),
    ).toBe(true);
  });

  it("keeps regular registration and help on passive policy", () => {
    expect(resolveCliCommandPathPolicy(["update", "plan"])).toMatchObject({
      configGuard: "skip",
      stateStoreGuard: "skip",
      loadPlugins: "never",
      ensureCliPath: false,
      networkProxy: "bypass",
    });
  });
});
