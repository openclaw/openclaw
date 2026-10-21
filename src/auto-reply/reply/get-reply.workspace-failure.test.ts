import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { holdWorkspacePreparationSnapshot } from "../../agents/workspace-preparation-queue.test-support.js";
import {
  WorkspaceAliasRepointedError,
  WorkspaceVanishedError,
} from "../../agents/workspace-state-identity.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildGetReplyCtx, registerGetReplyRuntimeOverrides } from "./get-reply.test-fixtures.js";
import "./get-reply.test-runtime-mocks.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { beforeSettlement, expectCallCounts } from "./reply-contract.test-support.js";

const mocks = vi.hoisted(() => ({
  resolveReplyDirectives: vi.fn(),
  initSessionState: vi.fn(),
}));
registerGetReplyRuntimeOverrides(mocks);
const { getReplyFromConfig } = await import("./get-reply.js");
const { getRuntimeConfig } = await import("../../config/config.js");
const { ensureAgentWorkspace } = await import("../../agents/workspace.js");
const { runPreparedReply } = await import("./get-reply-run.js");
const actualWorkspace = await vi.importActual<typeof import("../../agents/workspace.js")>(
  "../../agents/workspace.js",
);
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

it.each([
  [aliasError, "openclaw doctor"],
  [new WorkspaceVanishedError({ workspaceDir: "/home/user/clawd" }), "workspace is missing"],
] as const)("reports %s without exposing workspace paths", async (error, notice) => {
  vi.mocked(ensureAgentWorkspace).mockRejectedValueOnce(error);
  const reply = await getReplyFromConfig(buildGetReplyCtx(), undefined, {});
  expect(reply).toMatchObject({ text: expect.stringContaining(notice) });
  if (error === aliasError) {
    const text = [reply].flat()[0]?.text;
    expect(text).toContain("⚠️");
    expect(text).not.toMatch(/\/home\/user|\/srv\/data|(^|[\s(])\/[A-Za-z0-9_.-]+\//u);
  }
});

it("keeps heartbeat workspace failures throwing for heartbeat-owned logging", async () => {
  vi.mocked(ensureAgentWorkspace).mockRejectedValueOnce(aliasError);
  await expect(getReplyFromConfig(buildGetReplyCtx(), { isHeartbeat: true }, {})).rejects.toBe(
    aliasError,
  );
});

it("rejects queued reply preparation after abort or operator revocation without workspace effects", async ({
  signal,
}) => {
  vi.stubEnv("OPENCLAW_TEST_FAST", "0");
  for (const authority of ["abort", "operator"] as const) {
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "reply-workspace-authority-",
    });
    const held = holdWorkspacePreparationSnapshot(state.workspaceDir);
    const leader = held.run(() =>
      actualWorkspace.ensureAgentWorkspace({ dir: state.workspaceDir }),
    );
    try {
      await held.ready(leader, signal);
      const queued = createDeferred();
      vi.mocked(ensureAgentWorkspace).mockImplementationOnce((params) => {
        const pending = actualWorkspace.ensureAgentWorkspace(params);
        queued.resolve();
        return pending;
      });
      const controller = new AbortController();
      const reason = new Error(
        `Reply ${authority} authority retired while workspace preparation was queued`,
      );
      const options: InternalGetReplyOptions =
        authority === "abort"
          ? { abortSignal: controller.signal }
          : {
              operatorAuthority: createAdmittedRunOperatorAuthority({
                profileId: "workspace-test-operator",
                scopes: ["operator.write"],
                signal: controller.signal,
                assertCurrent: () => {},
              }),
            };
      mocks.initSessionState.mockClear();
      mocks.resolveReplyDirectives.mockClear();
      vi.mocked(runPreparedReply).mockClear();
      const preparing = held.run(() =>
        getReplyFromConfig(buildGetReplyCtx(), options, {
          agents: { defaults: { workspace: state.workspaceDir } },
        }),
      );
      await beforeSettlement(
        queued.promise,
        preparing,
        signal,
        "Reply did not queue workspace preparation",
      );
      controller.abort(reason);
      held.release();
      await leader;
      const error = await preparing.catch((caught: unknown) => caught);
      expect(await fs.readdir(state.workspaceDir)).toEqual([]);
      if (authority === "abort") {
        expect(error).toMatchObject({
          name: "AbortError",
          message: "Reply canceled during preprocessing",
          cause: reason,
        });
      } else {
        expect(error).toBe(reason);
      }
      expectCallCounts(
        0,
        mocks.initSessionState,
        mocks.resolveReplyDirectives,
        vi.mocked(runPreparedReply),
      );
    } finally {
      await held.dispose();
      await state.cleanup();
    }
  }
});
