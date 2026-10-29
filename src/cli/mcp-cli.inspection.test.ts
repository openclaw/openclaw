import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import { REDACTED_SENTINEL } from "../config/redact-snapshot.js";
import {
  cleanupMcpCliTestState,
  createWorkspace,
  lastLogLine,
  lastErrorLine,
  mockLog,
  resetMcpCliTestState,
  runMcpCommand,
} from "./mcp-cli.test-harness.js";

async function withMcpHome(run: (home: string) => Promise<void>) {
  await withTempHome("openclaw-cli-mcp-inspection-", async (home) => {
    vi.spyOn(process, "cwd").mockReturnValue(await createWorkspace());
    await run(home);
  });
}
beforeEach(() => resetMcpCliTestState());
afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupMcpCliTestState();
});

it("redacts MCP registry inspection without changing saved credentials", async () => {
  await withMcpHome(async (home) => {
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    vi.stubEnv("MCP_DISPLAY_TOKEN", "example-resolved-token-not-real");
    vi.stubEnv("MCP_DISPLAY_HEADER", "example-header-token-not-real");
    const servers = {
      remote: {
        url: "https://mcp.example.com/mcp",
        headers: {
          Authorization: "Bearer ${MCP_DISPLAY_HEADER}",
          "X-Goog-Api-Key": "example-maps-key-not-real",
          "X-Custom-Credential": "example-custom-header-not-real",
        },
      },
      local: {
        command: "node",
        args: ["server.mjs", "--api-key", "example-argv-key-not-real", "--region", "us-east-1"],
        env: {
          SERVICE_TOKEN: "example-env-token-not-real",
          REFERENCE: "${MCP_DISPLAY_TOKEN}",
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify({ mcp: { servers } }));

    for (const args of [
      ["list", "--json"],
      ["show", "--json"],
      ["show", "remote", "--json"],
      ["show", "local", "--json"],
      ["show"],
      ["show", "remote"],
      ["show", "local"],
    ]) {
      mockLog.mockClear();
      await runMcpCommand(["mcp", ...args]);
      const output = mockLog.mock.calls.map((call) => String(call[0])).join("\n");
      for (const secret of [
        "example-header-token-not-real",
        "example-maps-key-not-real",
        "example-custom-header-not-real",
        "example-argv-key-not-real",
        "example-env-token-not-real",
        "example-resolved-token-not-real",
      ]) {
        expect(output, args.join(" ")).not.toContain(secret);
      }
      const inspected = JSON.parse(lastLogLine());
      if (args[1] !== "remote" && args[1] !== "local") {
        expect(inspected.remote.url).toBe("https://mcp.example.com/mcp");
        expect(inspected.local.args).toContain("us-east-1");
        expect(inspected.local.env.REFERENCE).toBe(REDACTED_SENTINEL);
      }
    }

    expect(JSON.parse(await fs.readFile(configPath, "utf8")).mcp.servers).toEqual(servers);
    for (const name of ["remote", "local"]) {
      await runMcpCommand(["mcp", "show", name, "--json"]);
      await runMcpCommand(["mcp", "set", name, lastLogLine()]);
    }
    expect(JSON.parse(await fs.readFile(configPath, "utf8")).mcp.servers).toEqual(servers);
  });
});

it.each(["\u001b[31mred\u001b[0m", "\u001b]0;title\u0007", "line\r\n\tend", "nul\u0000c1\u0085Ω"])(
  "escapes untrusted registry text in human output but preserves structured data: %j",
  async (control) => {
    await withMcpHome(async (home) => {
      const name = "server-" + control;
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const servers = { [name]: { command: "binary-" + control, args: ["--region", "Ω"] } };
      const original = JSON.stringify({ mcp: { servers } });
      await fs.writeFile(configPath, original);
      for (const args of [["list"], ["status", "--verbose"], ["show", name]]) {
        mockLog.mockClear();
        await runMcpCommand(["mcp", ...args]);
        // Show emits a human heading followed by deliberately unmodified structured JSON.
        const humanCalls =
          args[0] === "show" ? mockLog.mock.calls.slice(0, -1) : mockLog.mock.calls;
        expect(humanCalls.length).toBeGreaterThan(0);
        for (const call of humanCalls) {
          expect(String(call[0])).not.toMatch(/\p{Cc}/u);
        }
      }
      for (const args of [
        ["list", "--json"],
        ["show", name, "--json"],
      ]) {
        mockLog.mockClear();
        await runMcpCommand(["mcp", ...args]);
        const shown = JSON.parse(lastLogLine());
        expect(args[0] === "list" ? shown[name] : shown).toEqual(servers[name]);
      }
      expect(await fs.readFile(configPath, "utf8")).toBe(original);
      await expect(runMcpCommand(["mcp", "show", "missing-" + control])).rejects.toMatchObject({
        code: 1,
      });
      expect(lastErrorLine()).not.toMatch(/\p{Cc}/u);
    });
  },
);

it("escapes registry mutation acknowledgments without changing stored names", async () => {
  await withMcpHome(async (home) => {
    const name = "owned\u001b[31m\r\n\tΩ";
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const server = { url: "https://mcp.example.test/mcp" };
    for (const args of [
      ["add", name, "--url", server.url, "--no-probe"],
      ["set", name, JSON.stringify(server)],
      ["configure", name, "--disable"],
      ["configure", name, "--enable"],
      ["logout", name],
      ["reload"],
      ["unset", name],
    ]) {
      mockLog.mockClear();
      await runMcpCommand(["mcp", ...args]);
      expect(mockLog).toHaveBeenCalled();
      for (const call of mockLog.mock.calls) {
        expect(String(call[0])).not.toMatch(/\p{Cc}/u);
      }
      const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
      if (args[0] !== "unset") {
        expect(Object.keys(saved.mcp.servers)).toContain(name);
      } else {
        expect(saved.mcp?.servers?.[name]).toBeUndefined();
      }
    }
  });
});
