import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  Client as V2Client,
  StreamableHTTPClientTransport as V2HttpTransport,
} from "@modelcontextprotocol/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { NodeClaudeSkillInit } from "../infra/node-claude-skill-protocol.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { createDeferredCore } from "../shared/deferred.js";
import { loadWorkspaceSkills } from "../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../skills/loading/workspace-skill-prompt.js";
import { prepareSkillResourceDelivery } from "../skills/runtime/resources.js";
import { prepareNodeClaudeSkillSession } from "./claude-skill-session.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const workshopFixture = { description: "Fixture", inputSchema: {} };
const workshopCall = { name: "skill_workshop", arguments: {} };
const mcpIdentity = { name: "workshop-fixture", version: "1" };
const textContent = (text: string | number) => ({ content: [{ type: "text", text }] });
const markdown = "---\ndescription: Guide\n---\n# Guide\n";

function prepareSession(
  init: Omit<NodeClaudeSkillInit, "type">,
  signal = new AbortController().signal,
  unsubscribe: () => void = vi.fn(),
) {
  const sent = createDeferredCore<Uint8Array>();
  let receive: ((bytes: Uint8Array) => void | Promise<void>) | undefined;
  const session = prepareNodeClaudeSkillSession({
    signal,
    emitChunk: vi.fn(),
    onInput: vi.fn(),
    frames: {
      send: async (bytes) => sent.resolve(bytes),
      onMessage: (listener) => {
        receive = listener;
        void listener(Buffer.from(JSON.stringify({ type: "init", ...init })));
        return unsubscribe;
      },
    },
  });
  return {
    session,
    sent: sent.promise,
    dispatch: (bytes: Uint8Array) => {
      assert(receive);
      return receive(bytes);
    },
  };
}

async function prepareWorkshop(sdk: string) {
  const prepared = prepareSession({ workshop: workshopFixture });
  const session = await prepared.session;
  const client =
    sdk === "v1"
      ? new Client(mcpIdentity)
      : new V2Client(mcpIdentity, { versionNegotiation: { mode: "legacy" } });
  onTestFinished(async () => {
    try {
      await client.close();
    } finally {
      try {
        await session.close();
      } finally {
        await session.cleanup();
      }
    }
  });
  const configPath = session.argv[session.argv.indexOf("--mcp-config") + 1];
  assert(configPath);
  const config: unknown = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert(isRecord(config) && isRecord(config.mcpServers));
  const endpoint = config.mcpServers.openclaw;
  assert(isRecord(endpoint) && typeof endpoint.url === "string");
  const url = new URL(endpoint.url);
  return {
    ...prepared,
    session,
    client,
    url,
    connect: () =>
      client.connect(
        sdk === "v1" ? new StreamableHTTPClientTransport(url) : new V2HttpTransport(url),
      ),
  };
}

async function skillResources() {
  const workspace = temps.make("node-skill-session-");
  const skillDir = path.join(workspace, "skills", "guide");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), markdown);
  const resources = await prepareSkillResourceDelivery(
    await buildSkillSnapshot(workspace, {
      entries: loadWorkspaceSkills(workspace, { workspaceOnly: true }),
    }),
    () => {},
  );
  return { skillDir, resources };
}

function captureWarnings() {
  const warn = vi.fn();
  const previousConsole = loggingState.rawConsole;
  setLoggerOverride({ level: "silent", consoleLevel: "warn" });
  loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
  onTestFinished(() => {
    loggingState.rawConsole = previousConsole;
    setLoggerOverride(null);
    resetLogger();
  });
  return warn;
}

describe("node Claude Workshop result settlement", () => {
  it.each(["v1", "v2"].flatMap((sdk) => [false, true].map((malformed) => ({ sdk, malformed }))))(
    "$sdk settles the real MCP request (malformed result: $malformed)",
    async ({ sdk, malformed }) => {
      const { client, connect, sent, dispatch } = await prepareWorkshop(sdk);
      await connect();
      const result = client.callTool(workshopCall);
      void result.catch(() => {});
      const request: unknown = JSON.parse(Buffer.from(await sent).toString("utf8"));
      assert(isRecord(request) && request.type === "workshop" && typeof request.id === "string");
      const response = Buffer.from(
        JSON.stringify({
          type: "result",
          id: request.id,
          result: textContent(malformed ? 42 : "Workshop result"),
        }),
      );
      if (malformed) {
        await expect(Promise.resolve().then(() => dispatch(response))).rejects.toMatchObject({
          name: "ZodError",
        });
        await expect(result).rejects.toMatchObject({ code: ErrorCode.InternalError });
      } else {
        await dispatch(response);
        await expect(result).resolves.toMatchObject(textContent("Workshop result"));
      }
    },
  );

  it.each(["v1", "v2"])(
    "%s preserves route authority and tears down pending HTTP calls",
    async (sdk) => {
      const { session, client, url, connect, sent } = await prepareWorkshop(sdk);
      for (const [target, options] of [
        [new URL("/mcp/wrong-invocation", url), { method: "POST" }],
        [url, { method: "POST", headers: { Origin: "https://unrelated.example" } }],
        [url, undefined],
      ] satisfies [URL, RequestInit | undefined][]) {
        expect((await fetch(target, options)).status).toBe(404);
      }
      await connect();
      const call = client.callTool(workshopCall);
      const rejected = expect(call).rejects.toBeInstanceOf(Error);
      await sent;
      await session.close();
      await rejected;
      await expect(session.writeStdout("late response")).rejects.toThrow("invocation closed");
      await expect(fetch(url, { method: "POST" })).rejects.toBeInstanceOf(Error);
    },
  );
});

describe("node Claude skill artifact cleanup", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each([false, true])(
    "grants only the artifact root and cleans independent inputs after close (Workshop: %s)",
    async (workshop) => {
      const { skillDir, resources } = await skillResources();
      const session = await prepareSession({
        resources,
        ...(workshop ? { workshop: workshopFixture } : {}),
      }).session;
      const artifactRoot = session.argv[session.argv.indexOf("--add-dir") + 1]!;
      const skillPath = session.rewriteReferences(path.join(skillDir, "SKILL.md"));
      const configPath = workshop
        ? session.argv[session.argv.indexOf("--mcp-config") + 1]!
        : undefined;
      const warn = captureWarnings();
      try {
        expect(session.argv.filter((arg) => arg === "--add-dir")).toHaveLength(1);
        expect(path.dirname(path.dirname(skillPath))).toBe(artifactRoot);
        expect((await fs.stat(artifactRoot)).mode & 0o777).toBe(0o700);
        expect(session.catalog).toContain(skillPath);
        if (configPath) {
          expect(path.relative(artifactRoot, configPath).startsWith(`..${path.sep}`)).toBe(true);
          expect((await fs.stat(path.dirname(configPath))).mode & 0o777).toBe(0o700);
        }
        await fs.chmod(path.dirname(skillPath), 0o500);
        await session.close();
        await expect(session.writeStdout("late output")).rejects.toThrow("invocation closed");
        await expect(session.cleanup()).resolves.toBeUndefined();
        expect(await fs.readFile(skillPath, "utf8")).toContain("# Guide");
        if (configPath) {
          await expect(fs.stat(path.dirname(configPath))).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls.flat().join("\n")).toContain(artifactRoot);
      } finally {
        await session.close();
        await fs.chmod(path.dirname(skillPath), 0o700);
        await session.cleanup();
      }
    },
  );

  it("preserves the exact frozen setup error when partial skill cleanup fails", async () => {
    const { resources } = await skillResources();
    const primary = new Error("Node skill setup cancelled");
    primary.name = "AbortError";
    Object.freeze(primary);
    const controller = new AbortController();
    let directory: string | undefined;
    const originalWriteFile = fs.writeFile;
    const writeFile = vi
      .spyOn(fs, "writeFile")
      .mockImplementation(async (target, data, options) => {
        await originalWriteFile(target, data, options);
        if (typeof target === "string" && path.basename(target) === "SKILL.md") {
          directory = path.dirname(path.dirname(target));
          controller.abort(primary);
        }
      });
    const originalRm = fs.rm;
    const deletionError = new Error("EACCES: retained node skill artifact");
    const rm = vi.spyOn(fs, "rm").mockImplementation((target, options) => {
      if (
        directory &&
        (String(target) === directory || String(target).startsWith(`${directory}${path.sep}`))
      ) {
        return Promise.reject(deletionError);
      }
      return originalRm(target, options);
    });
    const warn = captureWarnings();
    const unsubscribe = vi.fn();
    try {
      const result = await prepareSession(
        { resources },
        controller.signal,
        unsubscribe,
      ).session.catch((error: unknown) => error);
      expect.soft(result).toBe(primary);
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      writeFile.mockRestore();
      rm.mockRestore();
      if (directory) {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  });
});
