import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  buildQaTarget,
  parseQaTarget,
  sanitizeQaBusToolCalls,
  type QaTargetParts,
} from "./qa-channel-protocol.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const execute = promisify(execFile);
const targets: Array<[string, QaTargetParts["chatType"], string, string?]> = [
  ["dm:Alice", "direct", "Alice"],
  ["group:Room", "group", "Room"],
  ["channel:CaseSensitive", "channel", "CaseSensitive"],
  ["dm:Case/Room", "direct", "Case/Room"],
  ["group:Case/Room", "group", "Case/Room"],
  ["channel:Case/Room", "channel", "Case/Room"],
  ["thread:Room/Topic", "channel", "Room", "Topic"],
  ["thread:/v1/dm/Alice/Topic", "direct", "Alice", "Topic"],
  ["thread:/v1/group/Room%2FOne/Topic%2FTwo", "group", "Room/One", "Topic/Two"],
];

it("loads natively when the private QA SDK alias selects its source", async () => {
  // Only the SDK resolver uses tsx; the source facade must load natively.
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
  for (const [target, chatType, conversationId, threadId] of targets) {
    expect(buildQaTarget({ chatType, conversationId, threadId })).toBe(target);
  }
});

it("parses canonical targets without folding ids or prefix casing", () => {
  for (const [target, chatType, conversationId, threadId] of targets) {
    expect(parseQaTarget(target)).toEqual({
      chatType,
      conversationId,
      ...(threadId ? { threadId } : {}),
    });
  }
  expect(parseQaTarget("bare-id", { defaultChatType: "group" })).toEqual({
    chatType: "group",
    conversationId: "bare-id",
  });
  expect(() => parseQaTarget("CHANNEL:CaseSensitive")).toThrow(
    "qa-channel target prefixes must be lowercase",
  );
  expect(() => parseQaTarget("")).toThrow("qa-channel target is required");
  expect(() => parseQaTarget("dm:")).toThrow("invalid qa-channel dm target");
  const invalidThread = "invalid qa-channel thread target";
  expect(() => parseQaTarget("thread:Room/")).toThrow(invalidThread);
  expect(() => parseQaTarget("thread:/v1/group/Room/%GG")).toThrow(invalidThread);
});

it("preserves QA bus tool-call arguments while normalizing calls", () => {
  const args = {
    command: "cat README.md",
    apiToken: "secret-token",
    headers: { Authorization: "Bearer sk_test_12345678901234567890" },
    headerPairs: [
      ["X-API-Key", "secret"],
      ["Accept", "application/json"],
    ],
    argv: ["gh", "api", "--token", "secret-token", "repos/openclaw/openclaw"],
    values: ["ok", { password: "hunter2" }],
  };
  const expectedArgs = structuredClone(args);
  expect(
    sanitizeQaBusToolCalls([null, { name: 123 }, { name: " exec ", arguments: args }]),
  ).toEqual([{ name: "exec", arguments: expectedArgs }]);
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
