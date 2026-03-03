import { beforeEach, describe, expect, it, vi } from "vitest";
import { findRoutedCommand } from "./routes.js";

const runConfigGetMock = vi.hoisted(() => vi.fn(async () => {}));
const runConfigUnsetMock = vi.hoisted(() => vi.fn(async () => {}));
const modelsListCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const modelsStatusCommandMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../config-cli.js", () => ({
  runConfigGet: runConfigGetMock,
  runConfigUnset: runConfigUnsetMock,
}));

vi.mock("../../commands/models.js", () => ({
  modelsListCommand: modelsListCommandMock,
  modelsStatusCommand: modelsStatusCommandMock,
}));

describe("program routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function expectRoute(path: string[]) {
    const route = findRoutedCommand(path);
    expect(route).not.toBeNull();
    return route;
  }

  async function expectRunFalse(path: string[], argv: string[]) {
    const route = expectRoute(path);
    await expect(route?.run(argv)).resolves.toBe(false);
  }

  it("matches status route and always loads plugins for security parity", () => {
    const route = expectRoute(["status"]);
    expect(route?.loadPlugins).toBe(true);
  });

  it("matches health route and preloads plugins only for text output", () => {
    const route = expectRoute(["health"]);
    expect(typeof route?.loadPlugins).toBe("function");
    const shouldLoad = route?.loadPlugins as (argv: string[]) => boolean;
    expect(shouldLoad(["node", "@hanzo/bot", "health"])).toBe(true);
    expect(shouldLoad(["node", "@hanzo/bot", "health", "--json"])).toBe(false);
  });

  it("returns false when status timeout flag value is missing", async () => {
    await expectRunFalse(["status"], ["node", "@hanzo/bot", "status", "--timeout"]);
  });

  it("returns false for sessions route when --store value is missing", async () => {
    await expectRunFalse(["sessions"], ["node", "@hanzo/bot", "sessions", "--store"]);
  });

  it("returns false for sessions route when --active value is missing", async () => {
    await expectRunFalse(["sessions"], ["node", "@hanzo/bot", "sessions", "--active"]);
  });

  it("returns false for sessions route when --agent value is missing", async () => {
    await expectRunFalse(["sessions"], ["node", "@hanzo/bot", "sessions", "--agent"]);
  });

  it("does not fast-route sessions subcommands", () => {
    expect(findRoutedCommand(["sessions", "cleanup"])).toBeNull();
  });

  it("does not match unknown routes", () => {
    expect(findRoutedCommand(["definitely-not-real"])).toBeNull();
  });

  it("returns false for config get route when path argument is missing", async () => {
    await expectRunFalse(["config", "get"], ["node", "@hanzo/bot", "config", "get", "--json"]);
  });

  it("returns false for config unset route when path argument is missing", async () => {
    await expectRunFalse(["config", "unset"], ["node", "@hanzo/bot", "config", "unset"]);
  });

  it("passes config get path correctly when root option values precede command", async () => {
    const route = expectRoute(["config", "get"]);
    await expect(
      route?.run([
        "node",
        "@hanzo/bot",
        "--log-level",
        "debug",
        "config",
        "get",
        "update.channel",
        "--json",
      ]),
    ).resolves.toBe(true);
    expect(runConfigGetMock).toHaveBeenCalledWith({ path: "update.channel", json: true });
  });

  it("passes config unset path correctly when root option values precede command", async () => {
    const route = expectRoute(["config", "unset"]);
    await expect(
      route?.run(["node", "@hanzo/bot", "--profile", "work", "config", "unset", "update.channel"]),
    ).resolves.toBe(true);
    expect(runConfigUnsetMock).toHaveBeenCalledWith({ path: "update.channel" });
  });

  it("passes config get path when root value options appear after subcommand", async () => {
    const route = expectRoute(["config", "get"]);
    await expect(
      route?.run([
        "node",
        "@hanzo/bot",
        "config",
        "get",
        "--log-level",
        "debug",
        "update.channel",
        "--json",
      ]),
    ).resolves.toBe(true);
    expect(runConfigGetMock).toHaveBeenCalledWith({ path: "update.channel", json: true });
  });

  it("passes config unset path when root value options appear after subcommand", async () => {
    const route = expectRoute(["config", "unset"]);
    await expect(
      route?.run(["node", "@hanzo/bot", "config", "unset", "--profile", "work", "update.channel"]),
    ).resolves.toBe(true);
    expect(runConfigUnsetMock).toHaveBeenCalledWith({ path: "update.channel" });
  });

  it("returns false for config get route when unknown option appears", async () => {
    await expectRunFalse(
      ["config", "get"],
      ["node", "@hanzo/bot", "config", "get", "--mystery", "value", "update.channel"],
    );
  });

  it("returns false for memory status route when --agent value is missing", async () => {
    await expectRunFalse(
      ["memory", "status"],
      ["node", "@hanzo/bot", "memory", "status", "--agent"],
    );
  });

  it("returns false for models list route when --provider value is missing", async () => {
    await expectRunFalse(
      ["models", "list"],
      ["node", "@hanzo/bot", "models", "list", "--provider"],
    );
  });

  it("returns false for models status route when probe flags are missing values", async () => {
    await expectRunFalse(
      ["models", "status"],
      ["node", "@hanzo/bot", "models", "status", "--probe-provider"],
    );
    await expectRunFalse(
      ["models", "status"],
      ["node", "@hanzo/bot", "models", "status", "--probe-timeout"],
    );
    await expectRunFalse(
      ["models", "status"],
      ["node", "@hanzo/bot", "models", "status", "--probe-concurrency"],
    );
    await expectRunFalse(
      ["models", "status"],
      ["node", "@hanzo/bot", "models", "status", "--probe-max-tokens"],
    );
    await expectRunFalse(
      ["models", "status"],
      ["node", "@hanzo/bot", "models", "status", "--probe-provider", "openai", "--agent"],
    );
  });

  it("returns false for models status route when --probe-profile has no value", async () => {
    await expectRunFalse(
      ["models", "status"],
      ["node", "@hanzo/bot", "models", "status", "--probe-profile"],
    );
  });

  it("accepts negative-number probe profile values", async () => {
    const route = expectRoute(["models", "status"]);
    await expect(
      route?.run([
        "node",
        "@hanzo/bot",
        "models",
        "status",
        "--probe-provider",
        "openai",
        "--probe-timeout",
        "5000",
        "--probe-concurrency",
        "2",
        "--probe-max-tokens",
        "64",
        "--probe-profile",
        "-1",
        "--agent",
        "default",
      ]),
    ).resolves.toBe(true);
    expect(modelsStatusCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        probeProvider: "openai",
        probeTimeout: "5000",
        probeConcurrency: "2",
        probeMaxTokens: "64",
        probeProfile: "-1",
        agent: "default",
      }),
      expect.any(Object),
    );
  });
});
