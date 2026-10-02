import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  WorkspaceAliasRepointedError,
  WorkspaceVanishedError,
} from "../../agents/workspace-state-identity.js";
import { buildGetReplyCtx, registerGetReplyRuntimeOverrides } from "./get-reply.test-fixtures.js";
import "./get-reply.test-runtime-mocks.js";

const mocks = vi.hoisted(() => ({
  resolveReplyDirectives: vi.fn(),
  initSessionState: vi.fn(),
}));
registerGetReplyRuntimeOverrides(mocks);
const { getReplyFromConfig } = await import("./get-reply.js");
const { getRuntimeConfig } = await import("../../config/config.js");
const { ensureAgentWorkspace } = await import("../../agents/workspace.js");
const aliasError = new WorkspaceAliasRepointedError({
  aliasPath: "/home/user/clawd",
  storedWorkspacePath: "/home/user/clawd-old",
  currentWorkspacePath: "/srv/data/clawd",
});

beforeEach(() => {
  vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
  vi.mocked(getRuntimeConfig).mockReset().mockReturnValue({});
  vi.mocked(ensureAgentWorkspace).mockReset();
});
afterEach(() => vi.unstubAllEnvs());

it("returns a visible repair notice without sending workspace paths to the channel", async () => {
  vi.mocked(ensureAgentWorkspace).mockRejectedValueOnce(aliasError);
  const reply = await getReplyFromConfig(buildGetReplyCtx(), undefined, {});
  expect(reply).toMatchObject({ text: expect.stringContaining("openclaw doctor") });
  const text = [reply].flat()[0]?.text;
  expect(text).toContain("⚠️");
  expect(text).not.toContain("/home/user");
  expect(text).not.toContain("/srv/data");
  expect(text).not.toMatch(/(^|[\s(])\/[A-Za-z0-9_.-]+\//u);
});

it("turns a vanished workspace into a visible terminal reply", async () => {
  vi.mocked(ensureAgentWorkspace).mockRejectedValueOnce(
    new WorkspaceVanishedError({ workspaceDir: "/home/user/clawd" }),
  );
  await expect(getReplyFromConfig(buildGetReplyCtx(), undefined, {})).resolves.toMatchObject({
    text: expect.stringContaining("workspace is missing"),
  });
});

it("keeps heartbeat workspace failures throwing for heartbeat-owned logging", async () => {
  vi.mocked(ensureAgentWorkspace).mockRejectedValueOnce(aliasError);
  await expect(getReplyFromConfig(buildGetReplyCtx(), { isHeartbeat: true }, {})).rejects.toBe(
    aliasError,
  );
});

it("rethrows other workspace provisioning failures unchanged", async () => {
  vi.mocked(ensureAgentWorkspace).mockRejectedValueOnce(new Error("EACCES: permission denied"));
  await expect(getReplyFromConfig(buildGetReplyCtx(), undefined, {})).rejects.toThrow(/EACCES/u);
});
