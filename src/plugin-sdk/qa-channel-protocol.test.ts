// QA channel protocol tests cover synthetic channel payload validation and parsing.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildQaTarget, parseQaTarget, sanitizeQaBusToolCalls } from "./qa-channel-protocol.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const execute = promisify(execFile);

describe("qa-channel protocol", () => {
  it("loads natively when the private QA SDK alias selects its source", async () => {
    // Ordinary builds omit private QA SDK artifacts, so a built Gateway loads
    // this source facade without a TypeScript resolver. Only the SDK resolver
    // itself goes through tsx's scoped loader here.
    const root = fs.realpathSync(temp.make("qa-channel-protocol-native-"));
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"qa-probe","type":"module"}\n');
    const entry = path.join(root, "index.mjs");
    fs.writeFileSync(
      entry,
      'export { parseQaTarget } from "openclaw/plugin-sdk/qa-channel-protocol";\n',
    );
    const resolverUrl = new URL("../plugins/plugin-sdk-native-resolver.ts", import.meta.url).href;
    const { stdout } = await execute(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { tsImport } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))};
         const { installOpenClawPluginSdkNativeResolver } = await tsImport(${JSON.stringify(resolverUrl)}, {
           parentURL: import.meta.url,
           tsconfig: ${JSON.stringify(path.resolve("tsconfig.json"))},
         });
         installOpenClawPluginSdkNativeResolver({ pluginModulePath: ${JSON.stringify(entry)}, pluginSdkResolution: "src" });
         const { parseQaTarget } = await import(${JSON.stringify(pathToFileURL(entry).href)});
         console.log(JSON.stringify(parseQaTarget("thread:/v1/dm/Case%2FID/Thread")));`,
      ],
      { env: { ...process.env, OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1" } },
    );
    expect(JSON.parse(stdout)).toEqual({
      chatType: "direct",
      conversationId: "Case/ID",
      threadId: "Thread",
    });
  });

  it("builds canonical targets", () => {
    expect(buildQaTarget({ chatType: "direct", conversationId: "Alice" })).toBe("dm:Alice");
    expect(buildQaTarget({ chatType: "group", conversationId: "Room" })).toBe("group:Room");
    expect(buildQaTarget({ chatType: "channel", conversationId: "Room" })).toBe("channel:Room");
    expect(buildQaTarget({ chatType: "channel", conversationId: "Room", threadId: "Topic" })).toBe(
      "thread:Room/Topic",
    );
    expect(buildQaTarget({ chatType: "direct", conversationId: "Alice", threadId: "Topic" })).toBe(
      "thread:/v1/dm/Alice/Topic",
    );
    expect(
      buildQaTarget({ chatType: "group", conversationId: "Room/One", threadId: "Topic/Two" }),
    ).toBe("thread:/v1/group/Room%2FOne/Topic%2FTwo");
  });

  it("parses canonical targets without folding ids or prefix casing", () => {
    expect(parseQaTarget("channel:CaseSensitive")).toEqual({
      chatType: "channel",
      conversationId: "CaseSensitive",
    });
    expect(parseQaTarget("thread:Room/Topic")).toEqual({
      chatType: "channel",
      conversationId: "Room",
      threadId: "Topic",
    });
    expect(parseQaTarget("thread:/v1/group/Room%2FOne/Topic%2FTwo")).toEqual({
      chatType: "group",
      conversationId: "Room/One",
      threadId: "Topic/Two",
    });
    expect(parseQaTarget("thread:/v1/dm/Alice/Topic")).toEqual({
      chatType: "direct",
      conversationId: "Alice",
      threadId: "Topic",
    });
    expect(parseQaTarget("bare-id", { defaultChatType: "group" })).toEqual({
      chatType: "group",
      conversationId: "bare-id",
    });
    expect(() => parseQaTarget("CHANNEL:CaseSensitive")).toThrow(
      "qa-channel target prefixes must be lowercase",
    );
    expect(() => parseQaTarget("thread:Room/")).toThrow("invalid qa-channel thread target");
    expect(() => parseQaTarget("thread:/v1/group/Room/%GG")).toThrow(
      "invalid qa-channel thread target",
    );
  });

  it("preserves QA bus tool-call arguments while normalizing calls", () => {
    const toolCalls = sanitizeQaBusToolCalls([
      null,
      { name: 123 },
      {
        name: " exec ",
        arguments: {
          command: "cat README.md",
          apiToken: "secret-token",
          headers: {
            Authorization: "Bearer sk_test_12345678901234567890",
          },
          headerPairs: [
            ["X-API-Key", "secret"],
            ["Accept", "application/json"],
          ],
          argv: ["gh", "api", "--token", "secret-token", "repos/openclaw/openclaw"],
          values: ["ok", { password: "hunter2" }],
        },
      },
    ]);

    expect(toolCalls).toEqual([
      {
        name: "exec",
        arguments: {
          command: "cat README.md",
          apiToken: "secret-token",
          headers: {
            Authorization: "Bearer sk_test_12345678901234567890",
          },
          headerPairs: [
            ["X-API-Key", "secret"],
            ["Accept", "application/json"],
          ],
          argv: ["gh", "api", "--token", "secret-token", "repos/openclaw/openclaw"],
          values: ["ok", { password: "hunter2" }],
        },
      },
    ]);
  });

  it("caps QA bus tool-call sanitization before processing the tail", () => {
    const toolCalls = Array.from({ length: 50 }, (_, index) => ({
      name: `tool-${index}`,
    }));
    toolCalls.push({
      get name(): string {
        throw new Error("tail should not be sanitized");
      },
    });

    expect(sanitizeQaBusToolCalls(toolCalls)?.map((toolCall) => toolCall.name)).toHaveLength(50);
  });
});
