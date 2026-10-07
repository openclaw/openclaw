import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
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

const mocks = vi.hoisted(() => ({
  resolveReplyDirectives: vi.fn(),
  initSessionState: vi.fn(),
}));
registerGetReplyRuntimeOverrides(mocks);
const { getReplyFromConfigInternal } = await import("./get-reply.js");
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

it("returns a visible repair notice without sending workspace paths to the channel", async () => {
  vi.mocked(ensureAgentWorkspace).mockRejectedValueOnce(aliasError);
  const reply = await getReplyFromConfigInternal(buildGetReplyCtx(), undefined, {});
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
  await expect(
    getReplyFromConfigInternal(buildGetReplyCtx(), undefined, {}),
  ).resolves.toMatchObject({
    text: expect.stringContaining("workspace is missing"),
  });
});

it("rethrows other workspace provisioning failures unchanged", async () => {
  vi.mocked(ensureAgentWorkspace).mockRejectedValueOnce(new Error("EACCES: permission denied"));
  await expect(getReplyFromConfigInternal(buildGetReplyCtx(), undefined, {})).rejects.toThrow(
    /EACCES/u,
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
    const leader = actualWorkspace.ensureAgentWorkspace({ dir: state.workspaceDir });
    void leader.catch(() => undefined);
    let preparing: ReturnType<typeof getReplyFromConfigInternal> | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(held.entered, leader, "Workspace leader did not enter"),
        signal,
      );
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
      preparing = getReplyFromConfigInternal(buildGetReplyCtx(), options, {
        agents: { defaults: { workspace: state.workspaceDir } },
      });
      void preparing.catch(() => undefined);
      await withinTest(
        awaitGateBeforeSettlement(
          queued.promise,
          preparing,
          "Reply did not queue workspace preparation",
        ),
        signal,
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
      expect(mocks.initSessionState).not.toHaveBeenCalled();
      expect(mocks.resolveReplyDirectives).not.toHaveBeenCalled();
      expect(runPreparedReply).not.toHaveBeenCalled();
    } finally {
      await held.dispose([leader, preparing]);
      await state.cleanup();
    }
  }
});
