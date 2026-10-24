/** Real Gateway proof: a tools.github.configure failure records the cause in Gateway
 * diagnostics over the shipped RPC transport while the client response stays generic. */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { stripAnsi } from "../packages/terminal-core/src/ansi.js";
import { startGatewayWithClient } from "../src/gateway/test-helpers.e2e.js";
import { flushLogger } from "../src/logging/logger.js";
import { loggingState } from "../src/logging/state.js";
import { useRuntimeProofFixture } from "./runtime-proof.test-support.js";

const createFixture = useRuntimeProofFixture(afterEach);
const TOKEN = "pr181208-proof-token";
// Well-formed handle that was never registered as a one-use handoff.
const MISSING_SECRET_NAME = "github-setup-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

it(
  "records the configure failure cause in Gateway diagnostics through the RPC transport",
  { timeout: 90_000 },
  async () => {
    const fixture = await createFixture("openclaw-pr181208-proof-", TOKEN);
    const logFile = path.join(fixture.stateDir, "proof-gateway.log");
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    const consoleLines: string[] = [];
    const sink = (...args: unknown[]) => {
      consoleLines.push(args.map((arg) => String(arg)).join(" "));
    };
    const previousRawConsole = loggingState.rawConsole;
    const previousOverride = loggingState.overrideSettings;
    loggingState.rawConsole = { log: sink, info: sink, warn: sink, error: sink };
    // Vitest silences console and file logging by default; opt this proof into
    // both so the operator-visible console line and the raw file record are
    // captured exactly as a live Gateway would produce them.
    loggingState.overrideSettings = { level: "info", file: logFile, consoleLevel: "info" };
    loggingState.cachedSettings = null;
    loggingState.cachedConsoleSettings = null;
    try {
      const cfg = {
        agents: {
          defaults: { workspace: fixture.workspaceDir, skipBootstrap: true },
          entries: { main: {} },
        },
        gateway: { auth: { mode: "token", token: TOKEN } },
      };
      gateway = await startGatewayWithClient({
        cfg,
        configPath: fixture.configPath,
        token: TOKEN,
        clientDisplayName: "pr181208-proof-client",
      });
      consoleLines.length = 0;

      // The handler consumes the setup handoff, finds it unavailable, and must
      // record that cause server-side while the client-facing response keeps
      // the generic envelope (no cause text leaks into the RPC response).
      const failure = gateway.client.request("tools.github.configure", {
        scope: "system",
        agentId: "main",
        mode: "managed",
        secretName: MISSING_SECRET_NAME,
      });
      await expect(failure).rejects.toMatchObject({
        code: "UNAVAILABLE",
        message: "GitHub identity setup failed",
      });

      await flushLogger();
      // The owner-only file record keeps the raw cause (egress-only redaction;
      // nothing strips the cause before storage). The subsystem logger stores
      // the record under the tools-github subsystem with the message intact.
      const fileRecord = await fs.readFile(logFile, "utf8");
      expect(fileRecord).toContain("tools-github");
      expect(fileRecord).toContain(
        "GitHub identity setup failed: temporary GitHub credential is unavailable",
      );
      // The console presentation surfaces the same cause to the operator.
      // Strip ANSI styling: CI consoles emit colored subsystem tags, and the
      // assertion must hold with or without terminal color support.
      const plainConsole = stripAnsi(consoleLines.join("\n"));
      expect(plainConsole).toContain(
        "[tools-github] GitHub identity setup failed: temporary GitHub credential is unavailable",
      );
    } finally {
      loggingState.rawConsole = previousRawConsole;
      loggingState.overrideSettings = previousOverride;
      loggingState.cachedSettings = null;
      loggingState.cachedConsoleSettings = null;
      await fixture.close(gateway, undefined);
    }
  },
);
