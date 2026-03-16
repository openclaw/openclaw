import { beforeEach, describe, expect, it, vi } from "vitest";
import { findRoutedCommand } from "./routes.js";

const runConfigGetMock = vi.hoisted(() => vi.fn(async () => {}));
const runConfigUnsetMock = vi.hoisted(() => vi.fn(async () => {}));
const modelsListCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const modelsStatusCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const gatewayStatusCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const statusJsonCommandMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../config-cli.js", () => ({
  runConfigGet: runConfigGetMock,
  runConfigUnset: runConfigUnsetMock,
}));

vi.mock("../../commands/models.js", () => ({
  modelsListCommand: modelsListCommandMock,
  modelsStatusCommand: modelsStatusCommandMock,
}));

vi.mock("../../commands/gateway-status.js", () => ({
  gatewayStatusCommand: gatewayStatusCommandMock,
}));

vi.mock("../../commands/status-json.js", () => ({
  statusJsonCommand: statusJsonCommandMock,
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

  it("matches status route and preloads plugins only for text output", () => {
    const route = expectRoute(["status"]);
    expect(typeof route?.loadPlugins).toBe("function");
    const shouldLoad = route?.loadPlugins as (argv: string[]) => boolean;
    expect(shouldLoad(["node", "openclaw", "status"])).toBe(true);
    expect(shouldLoad(["node", "openclaw", "status", "--json"])).toBe(false);
  });

  it("matches health route and preloads plugins only for text output", () => {
    const route = expectRoute(["health"]);
    expect(typeof route?.loadPlugins).toBe("function");
    const shouldLoad = route?.loadPlugins as (argv: string[]) => boolean;
    expect(shouldLoad(["node", "openclaw", "health"])).toBe(true);
    expect(shouldLoad(["node", "openclaw", "health", "--json"])).toBe(false);
  });

  it("matches gateway status route without plugin preload", () => {
    const route = expectRoute(["gateway", "status"]);
    expect(route?.loadPlugins).toBeUndefined();
  });

  it("returns false for gateway status route when option values are missing", async () => {
    await expectRunFalse(["gateway", "status"], ["node", "openclaw", "gateway", "status", "--url"]);
    await expectRunFalse(
      ["gateway", "status"],
      ["node", "openclaw", "gateway", "status", "--token"],
    );
    await expectRunFalse(
      ["gateway", "status"],
      ["node", "openclaw", "gateway", "status", "--password"],
    );
    await expectRunFalse(
      ["gateway", "status"],
      ["node", "openclaw", "gateway", "status", "--timeout"],
    );
    await expectRunFalse(["gateway", "status"], ["node", "openclaw", "gateway", "status", "--ssh"]);
    await expectRunFalse(
      ["gateway", "status"],
      ["node", "openclaw", "gateway", "status", "--ssh-identity"],
    );
  });

  it("passes parsed gateway status flags through", async () => {
    const route = expectRoute(["gateway", "status"]);
    await expect(
      route?.run([
        "node",
        "openclaw",
        "--profile",
        "work",
        "gateway",
        "status",
        "--url",
        "ws://127.0.0.1:18789",
        "--token",
        "abc",
        "--password",
        "def",
        "--timeout",
        "5000",
        "--ssh",
        "user@host",
        "--ssh-identity",
        "~/.ssh/id_test",
        "--ssh-auto",
        "--json",
      ]),
    ).resolves.toBe(true);
    expect(gatewayStatusCommandMock).toHaveBeenCalledWith(
      {
        url: "ws://127.0.0.1:18789",
        token: "abc",
        password: "def",
        timeout: "5000",
        json: true,
        ssh: "user@host",
        sshIdentity: "~/.ssh/id_test",
        sshAuto: true,
      },
      expect.any(Object),
    );
  });

  it("returns false when status timeout flag value is missing", async () => {
    await expectRunFalse(["status"], ["node", "openclaw", "status", "--timeout"]);
  });

  it("routes status --json through the lean JSON command", async () => {
    const route = expectRoute(["status"]);
    await expect(
      route?.run([
        "node",
        "openclaw",
        "status",
        "--json",
        "--deep",
        "--usage",
        "--timeout",
        "5000",
      ]),
    ).resolves.toBe(true);
    expect(statusJsonCommandMock).toHaveBeenCalledWith(
      { deep: true, all: false, usage: true, timeoutMs: 5000 },
      expect.any(Object),
    );
  });

  it("returns false for sessions route when --store value is missing", async () => {
    await expectRunFalse(["sessions"], ["node", "openclaw", "sessions", "--store"]);
  });

  it("returns false for sessions route when --active value is missing", async () => {
    await expectRunFalse(["sessions"], ["node", "openclaw", "sessions", "--active"]);
  });

  it("returns false for sessions route when --agent value is missing", async () => {
    await expectRunFalse(["sessions"], ["node", "openclaw", "sessions", "--agent"]);
  });

  it("does not fast-route sessions subcommands", () => {
    expect(findRoutedCommand(["sessions", "cleanup"])).toBeNull();
  });

  it("does not match unknown routes", () => {
    expect(findRoutedCommand(["definitely-not-real"])).toBeNull();
  });

  it("returns false for config get route when path argument is missing", async () => {
    await expectRunFalse(["config", "get"], ["node", "openclaw", "config", "get", "--json"]);
  });

  it("returns false for config unset route when path argument is missing", async () => {
    await expectRunFalse(["config", "unset"], ["node", "openclaw", "config", "unset"]);
  });

  it("passes config get path correctly when root option values precede command", async () => {
    const route = expectRoute(["config", "get"]);
    await expect(
      route?.run([
        "node",
        "openclaw",
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
      route?.run(["node", "openclaw", "--profile", "work", "config", "unset", "update.channel"]),
    ).resolves.toBe(true);
    expect(runConfigUnsetMock).toHaveBeenCalledWith({ path: "update.channel" });
  });

  it("passes config get path when root value options appear after subcommand", async () => {
    const route = expectRoute(["config", "get"]);
    await expect(
      route?.run([
        "node",
        "openclaw",
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
      route?.run(["node", "openclaw", "config", "unset", "--profile", "work", "update.channel"]),
    ).resolves.toBe(true);
    expect(runConfigUnsetMock).toHaveBeenCalledWith({ path: "update.channel" });
  });

  it("returns false for config get route when unknown option appears", async () => {
    await expectRunFalse(
      ["config", "get"],
      ["node", "openclaw", "config", "get", "--mystery", "value", "update.channel"],
    );
  });

  it("returns false for memory status route when --agent value is missing", async () => {
    await expectRunFalse(["memory", "status"], ["node", "openclaw", "memory", "status", "--agent"]);
  });

  it("returns false for models list route when --provider value is missing", async () => {
    await expectRunFalse(["models", "list"], ["node", "openclaw", "models", "list", "--provider"]);
  });

  it("returns false for models status route when probe flags are missing values", async () => {
    await expectRunFalse(
      ["models", "status"],
      ["node", "openclaw", "models", "status", "--probe-provider"],
    );
    await expectRunFalse(
      ["models", "status"],
      ["node", "openclaw", "models", "status", "--probe-timeout"],
    );
    await expectRunFalse(
      ["models", "status"],
      ["node", "openclaw", "models", "status", "--probe-concurrency"],
    );
    await expectRunFalse(
      ["models", "status"],
      ["node", "openclaw", "models", "status", "--probe-max-tokens"],
    );
    await expectRunFalse(
      ["models", "status"],
      ["node", "openclaw", "models", "status", "--probe-provider", "openai", "--agent"],
    );
  });

  it("returns false for models status route when --probe-profile has no value", async () => {
    await expectRunFalse(
      ["models", "status"],
      ["node", "openclaw", "models", "status", "--probe-profile"],
    );
  });

  it("accepts negative-number probe profile values", async () => {
    const route = expectRoute(["models", "status"]);
    await expect(
      route?.run([
        "node",
        "openclaw",
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
