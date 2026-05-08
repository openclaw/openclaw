import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../channels/plugins/index.js", () => ({ getChannelPlugin: vi.fn() }));
vi.mock("../../../channels/plugins/types.public.js", () => ({
  CHANNEL_MESSAGE_ACTION_NAMES: [],
}));
vi.mock("../../../cli/message-secret-scope.js", () => ({
  resolveMessageSecretScope: vi.fn(() => ({ channel: undefined })),
}));
vi.mock("../../../commands/message.js", () => ({ messageCommand: vi.fn() }));
vi.mock("../../../globals.js", () => ({ danger: (s: string) => s, setVerbose: vi.fn() }));
vi.mock("../../../infra/outbound/channel-target.js", () => ({ CHANNEL_TARGET_DESCRIPTION: "" }));
vi.mock("../../../plugins/hook-runner-global.js", () => ({
  runGlobalGatewayStopSafely: vi.fn(),
}));
vi.mock("../../../runtime.js", () => ({
  defaultRuntime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
}));
vi.mock("../../cli-utils.js", () => ({ runCommandWithRuntime: vi.fn() }));
vi.mock("../../deps.js", () => ({ createDefaultDeps: vi.fn(() => ({})) }));
vi.mock("../../plugin-registry.js", () => ({ ensurePluginRegistryLoaded: vi.fn() }));

const { resolveMessageFromFile } = await import("./helpers.js");

describe("resolveMessageFromFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "openclaw-msgfile-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("test_simple_message_from_file", () => {
    const file = join(tmpDir, "msg.txt");
    writeFileSync(file, "Hello", "utf-8");
    const result = resolveMessageFromFile({ messageFile: file });
    expect(result.message).toBe("Hello");
  });

  it("test_multiline_message_preserved", () => {
    const content = "line one\nline two\nline three";
    const file = join(tmpDir, "multiline.txt");
    writeFileSync(file, content, "utf-8");
    const result = resolveMessageFromFile({ messageFile: file });
    expect(result.message).toBe(content);
  });

  it("test_special_chars_preserved", () => {
    const content = 'price=$100 `backtick` "quoted" \'single\' { "json": true } ```code fence```';
    const file = join(tmpDir, "special.txt");
    writeFileSync(file, content, "utf-8");
    const result = resolveMessageFromFile({ messageFile: file });
    expect(result.message).toBe(content);
  });

  it("test_missing_file_throws", () => {
    const missing = join(tmpDir, "does-not-exist.txt");
    expect(() => resolveMessageFromFile({ messageFile: missing })).toThrow("file not found");
  });

  it("test_empty_file_throws_by_default", () => {
    const file = join(tmpDir, "empty.txt");
    writeFileSync(file, "", "utf-8");
    expect(() => resolveMessageFromFile({ messageFile: file })).toThrow("file is empty");
  });

  it("test_empty_file_with_allow_empty", () => {
    const file = join(tmpDir, "empty.txt");
    writeFileSync(file, "", "utf-8");
    const result = resolveMessageFromFile({ messageFile: file, allowEmpty: true });
    expect(result.message).toBe("");
  });

  it("test_both_message_and_file_throws", () => {
    const file = join(tmpDir, "msg.txt");
    writeFileSync(file, "content", "utf-8");
    expect(() => resolveMessageFromFile({ message: "inline", messageFile: file })).toThrow(
      "Cannot supply both --message and --message-file",
    );
  });

  it("test_neither_passes_through", () => {
    const opts = { channel: "telegram", target: "@ops" };
    const result = resolveMessageFromFile(opts);
    expect(result).toEqual(opts);
  });

  it("test_file_not_removed_from_opts", () => {
    const file = join(tmpDir, "msg.txt");
    writeFileSync(file, "Hello", "utf-8");
    const result = resolveMessageFromFile({ messageFile: file, allowEmpty: false, channel: "tg" });
    expect(result).not.toHaveProperty("messageFile");
    expect(result).not.toHaveProperty("allowEmpty");
    expect(result).toHaveProperty("channel", "tg");
  });

  it("test_path_resolved_to_absolute", () => {
    const file = join(tmpDir, "relative-test.txt");
    writeFileSync(file, "relative content", "utf-8");
    const relPath = relative(process.cwd(), file);
    const result = resolveMessageFromFile({ messageFile: relPath });
    expect(result.message).toBe("relative content");
    expect(resolve(relPath)).toBe(file);
  });
});
