// QA Lab proof that session_status reports the Gateway's live tool inventory and its reasons.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createConfigIO, resetConfigRuntimeState } from "../../../../src/config/config.js";
import { replaceSessionEntry } from "../../../../src/config/sessions/session-accessor.js";
import {
  getGatewayTestPort,
  installGatewayTestHooks,
  startTestGatewayServer,
  testState,
} from "../../../../src/gateway/test-helpers.js";

installGatewayTestHooks();

const GATEWAY_TOKEN = "qa-session-capabilities-token";
const SESSION_KEY = "agent:main:qa-session-capabilities";

async function invokeSessionStatus(port: number, args: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${GATEWAY_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ tool: "session_status", args, sessionKey: SESSION_KEY }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("session_status capabilities product proof", () => {
  it(
    "names denied tools with their policy source through the real Gateway",
    { timeout: 90_000 },
    async () => {
      const port = await getGatewayTestPort();
      const configPath = createConfigIO().configPath;
      const storePath = path.join(path.dirname(configPath), "qa-capabilities", "sessions.json");
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      testState.sessionStorePath = storePath;
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            gateway: {
              mode: "local",
              port,
              auth: { mode: "token", token: GATEWAY_TOKEN },
              tools: { allow: ["session_status"] },
            },
            tools: { deny: ["browser", "canvas"] },
            session: { store: storePath },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      resetConfigRuntimeState();
      await replaceSessionEntry(
        { storePath, sessionKey: SESSION_KEY },
        { sessionId: "qa-session-capabilities", updatedAt: 1 },
      );

      const gateway = await startTestGatewayServer(port, {
        host: "127.0.0.1",
        auth: { mode: "token", token: GATEWAY_TOKEN },
        controlUiEnabled: false,
      });
      try {
        const plain = await invokeSessionStatus(port, {});
        expect(plain.status).toBe(200);
        expect(JSON.stringify(plain.body)).not.toContain("Capabilities (this session only");

        const checked = await invokeSessionStatus(port, { capabilities: true });
        expect(checked.status, JSON.stringify(checked.body)).toBe(200);
        const result = checked.body.result as { details?: Record<string, unknown> };
        const capabilities = result.details?.capabilities as {
          checked: string;
          error?: string;
          available: string[];
          unavailable: Array<{ reason: string; tools: string[] }>;
        };
        expect(capabilities.checked, capabilities.error).toBe("live-session");
        expect(capabilities.available).toContain("session_status");
        expect(capabilities.available).not.toContain("browser");
        const denied = capabilities.unavailable.find((entry) => entry.tools.includes("browser"));
        expect(denied?.reason).toMatch(/^Denied by tools\.deny/);
        expect(denied?.tools).toContain("canvas");
        expect(String(result.details?.statusText)).toContain(
          `- ${denied?.reason}: ${denied?.tools.join(", ")}`,
        );
      } finally {
        testState.sessionStorePath = undefined;
        await gateway.close();
      }
    },
  );
});
