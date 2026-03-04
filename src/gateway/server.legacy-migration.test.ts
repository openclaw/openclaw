import { describe, expect, test } from "vitest";
import {
  getFreePort,
  installGatewayTestHooks,
  startGatewayServer,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway startup legacy migration fallback", () => {
  test("surfaces detailed validation errors when legacy entries have no migration output", async () => {
    testState.legacyIssues = [
      {
        path: "heartbeat",
        message:
          "top-level heartbeat is not a valid config path; use agents.defaults.heartbeat (cadence/target/model settings) or channels.defaults.heartbeat (showOk/showAlerts/useIndicator).",
      },
    ];
    testState.legacyParsed = {
      heartbeat: { model: "anthropic/claude-3-5-haiku-20241022", every: "30m" },
    };
    testState.migrationConfig = null;
    testState.migrationChanges = [];

    let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
    let thrown: unknown;
    try {
      server = await startGatewayServer(await getFreePort());
    } catch (err) {
      thrown = err;
    }

    if (server) {
      await server.close();
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = String((thrown as Error).message);
    expect(message).toContain("Invalid config at");
    expect(message).toContain(
      "heartbeat: top-level heartbeat is not a valid config path; use agents.defaults.heartbeat (cadence/target/model settings) or channels.defaults.heartbeat (showOk/showAlerts/useIndicator).",
    );
    expect(message).not.toContain("Legacy config entries detected but auto-migration failed.");
  });

  test("keeps detailed validation errors when heartbeat comes from include-resolved config", async () => {
    testState.legacyIssues = [
      {
        path: "heartbeat",
        message:
          "top-level heartbeat is not a valid config path; use agents.defaults.heartbeat (cadence/target/model settings) or channels.defaults.heartbeat (showOk/showAlerts/useIndicator).",
      },
    ];
    // Simulate a parsed source that only contains include directives, while
    // legacy heartbeat is surfaced from the resolved config.
    testState.legacyParsed = {
      $include: ["heartbeat.defaults.json"],
    };
    testState.migrationConfig = null;
    testState.migrationChanges = [];

    let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
    let thrown: unknown;
    try {
      server = await startGatewayServer(await getFreePort());
    } catch (err) {
      thrown = err;
    }

    if (server) {
      await server.close();
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = String((thrown as Error).message);
    expect(message).toContain("Invalid config at");
    expect(message).toContain(
      "heartbeat: top-level heartbeat is not a valid config path; use agents.defaults.heartbeat (cadence/target/model settings) or channels.defaults.heartbeat (showOk/showAlerts/useIndicator).",
    );
    expect(message).not.toContain("Legacy config entries detected but auto-migration failed.");
  });
});
