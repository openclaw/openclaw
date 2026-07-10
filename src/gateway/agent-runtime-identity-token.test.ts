import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateConnectParams } from "../../packages/gateway-protocol/src/index.js";
import {
  CHAT_SEND_SESSION_KEY_MAX_LENGTH,
  HANDSHAKE_RUNTIME_TOKEN_MAX_LENGTH,
} from "../../packages/gateway-protocol/src/schema.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";

const envSnapshot = captureEnv(["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);

const tempHomes: string[] = [];

function useTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-runtime-"));
  tempHomes.push(home);
  setTestEnvValue("HOME", home);
  setTestEnvValue("OPENCLAW_HOME", home);
  setTestEnvValue("OPENCLAW_STATE_DIR", "");
  return home;
}

function execApprovalsPath(home: string): string {
  return path.join(home, ".openclaw", "exec-approvals.json");
}

function readExecApprovals(home: string): {
  socket?: { token?: string };
} {
  return JSON.parse(fs.readFileSync(execApprovalsPath(home), "utf8")) as {
    socket?: { token?: string };
  };
}

async function importRuntimeTokenModule(): Promise<
  typeof import("./agent-runtime-identity-token.js")
> {
  vi.resetModules();
  return await import("./agent-runtime-identity-token.js");
}

afterEach(() => {
  vi.resetModules();
  envSnapshot.restore();
  for (const home of tempHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe("agent runtime identity token", () => {
  it("persists the local signing secret so tokens verify across processes", async () => {
    const home = useTempHome();
    const firstProcess = await importRuntimeTokenModule();

    const token = firstProcess.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
    });

    const persistedToken = readExecApprovals(home).socket?.token;
    expect(persistedToken).toEqual(expect.any(String));
    expect(persistedToken).not.toHaveLength(0);

    const secondProcess = await importRuntimeTokenModule();
    expect(secondProcess.verifyAgentRuntimeIdentityToken(token)).toEqual({
      kind: "agentRuntime",
      agentId: "main",
      sessionKey: "session-1",
    });
  });

  it("does not mint local credentials while rejecting invalid presented tokens", async () => {
    const home = useTempHome();
    const runtimeToken = await importRuntimeTokenModule();

    expect(runtimeToken.verifyAgentRuntimeIdentityToken("not-a-valid-token")).toBeUndefined();
    expect(fs.existsSync(execApprovalsPath(home))).toBe(false);
  });

  it("mints a token from the longest chat-send-supported session key that passes the connect schema cap", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();

    const sessionKey = "k".repeat(CHAT_SEND_SESSION_KEY_MAX_LENGTH);
    const token = runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "agent-with-a-fairly-long-identifier-for-headroom-proof",
      sessionKey,
    });

    expect(token.length).toBeLessThanOrEqual(HANDSHAKE_RUNTIME_TOKEN_MAX_LENGTH);
    expect(runtimeToken.verifyAgentRuntimeIdentityToken(token)?.sessionKey).toBe(sessionKey);
    const ok = validateConnectParams({
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "test", version: "1.0.0", platform: "test", mode: "test" },
      caps: [],
      commands: [],
      role: "operator",
      scopes: ["operator.read"],
      auth: { agentRuntimeIdentityToken: token },
    });
    expect(ok).toBe(true);
  });

  it("fails at mint time instead of silently exceeding the connect schema cap", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();

    expect(() =>
      runtimeToken.mintAgentRuntimeIdentityToken({
        agentId: "main",
        sessionKey: "k".repeat(HANDSHAKE_RUNTIME_TOKEN_MAX_LENGTH),
      }),
    ).toThrow(/exceeds the \d+-char connect protocol cap/);
  });

  it("rejects tokens minted from a different local state directory", async () => {
    const firstHome = useTempHome();
    const firstProcess = await importRuntimeTokenModule();
    const token = firstProcess.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
    });
    expect(fs.existsSync(execApprovalsPath(firstHome))).toBe(true);

    useTempHome();
    const secondProcess = await importRuntimeTokenModule();
    const secondToken = secondProcess.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
    });

    expect(secondToken).not.toBe(token);
    expect(secondProcess.verifyAgentRuntimeIdentityToken(token)).toBeUndefined();
  });
});
