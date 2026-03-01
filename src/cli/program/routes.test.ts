import { describe, expect, it } from "vitest";
import { findRoutedCommand } from "./routes.js";

describe("program routes", () => {
  function expectRoute(path: string[]) {
    const route = findRoutedCommand(path);
    expect(route).not.toBeNull();
    return route;
  }

  async function expectRunFalse(path: string[], argv: string[]) {
    const route = expectRoute(path);
    await expect(route?.run(argv)).resolves.toBe(false);
  }

  it("matches status route and preserves plugin loading", () => {
    const route = expectRoute(["status"]);
    expect(route?.loadPlugins).toBe(true);
  });

  it("returns false when status timeout flag value is missing", async () => {
    await expectRunFalse(["status"], ["node", "openclaw", "status", "--timeout"]);
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
});
