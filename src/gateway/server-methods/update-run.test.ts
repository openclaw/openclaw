import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  createGatewayUpdateLifecycle,
  type UpdateCheckLifecycle,
} from "../../infra/update-check-lifecycle.js";
import { getUpdateRunAsync, listUpdateRunsAsync } from "../../infra/update-run-reader.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";

const prepareUpdate = vi.hoisted(() => vi.fn(async () => ({ status: "failed" })));
const install = vi.hoisted(() => ({ root: "/tmp/openclaw-checkout" }));
vi.mock("../../update/run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../update/run.js")>()),
  prepareUpdate,
}));
const scheduleGatewayRestart = vi.hoisted(() => vi.fn());
vi.mock("../../infra/restart.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/restart.js")>()),
  scheduleGatewayRestart,
}));
vi.mock("../../infra/update-install-status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-install-status.js")>()),
  resolveStartupInstallStatus: async () => ({
    root: install.root,
    status: { root: install.root, installKind: "git", packageManager: "pnpm" },
    installReceipt: null,
  }),
}));
// mock-isolation: admission reads the real install owner and process root; this test starts after it.
vi.mock("./update-admission.js", () => ({
  admitGatewayUpdateRequest: async (request: { params: unknown }) => request.params,
}));

let lifecycle: UpdateCheckLifecycle;
let home: TempHomeEnv;
beforeEach(async () => {
  home = await createTempHomeEnv("openclaw-update-run-git-");
  lifecycle = createGatewayUpdateLifecycle(createTestGatewayScheduler());
  install.root = "/tmp/openclaw-checkout";
});
afterEach(async () => {
  await lifecycle.stop();
  await home.restore();
  vi.unstubAllEnvs();
  prepareUpdate.mockClear();
});

async function invoke(params: object, client: unknown = null) {
  const { updateRunHandler } = await import("./update-run.js");
  const respond = vi.fn();
  const broadcast = vi.fn();
  await updateRunHandler({
    req: { type: "req", id: "1", method: "update.run" },
    params,
    client,
    isWebchatConnect: () => false,
    respond,
    context: { getRuntimeConfig: () => ({}), broadcast },
  } as unknown as Parameters<typeof updateRunHandler>[0]);
  expect(respond).toHaveBeenCalledOnce();
  return { payload: respond.mock.calls[0]?.[1], broadcast };
}

it("refuses before preparing a release when the Gateway may not replace its process", async () => {
  vi.stubEnv("OPENCLAW_NO_RESPAWN", "1");
  const { payload } = await invoke({});
  expect(payload).toMatchObject({ runId: null, ok: false, code: "restart-unavailable" });
  expect(prepareUpdate).not.toHaveBeenCalled();
});

it("shows a Control UI update in the app instead of the conversation", async () => {
  const { payload, broadcast } = await invoke(
    { requester: { channel: INTERNAL_MESSAGE_CHANNEL } },
    {
      connect: {
        client: { id: GATEWAY_CLIENT_IDS.CONTROL_UI, mode: GATEWAY_CLIENT_MODES.WEBCHAT },
      },
    },
  );
  expect(payload).toMatchObject({ ok: true, noticeInApp: true });
  expect(payload.acknowledgement).toBeUndefined();
  expect((await getUpdateRunAsync(payload.runId))?.origin.noticeSurface).toBe("app");
  expect(broadcast).toHaveBeenCalledWith(
    "update.run.changed",
    expect.objectContaining({ runId: payload.runId, status: "running" }),
  );
});

it("applies the commit a scheduled campaign pinned instead of the moving upstream", async () => {
  const sha = "c".repeat(40);
  const bindRun = vi.fn();
  lifecycle.campaign = {
    adopt: () => ({
      status: "adopted",
      campaignId: "campaign-1",
      target: { kind: "git", upstreamRef: "origin/main", upstreamSha: sha, commitsBehind: 1 },
    }),
    bindRun,
    clear: vi.fn(),
  } as unknown as NonNullable<UpdateCheckLifecycle["campaign"]>;
  const { payload } = await invoke({});
  expect(payload).toMatchObject({ ok: true });
  const run = await getUpdateRunAsync(payload.runId);
  expect(run).toMatchObject({
    trigger: "campaign",
    origin: { campaignId: "campaign-1" },
    target: { sha },
  });
  expect(bindRun).toHaveBeenCalledWith("campaign-1", payload.runId);
  await vi.waitFor(() =>
    expect(prepareUpdate).toHaveBeenCalledWith(expect.objectContaining({ sha })),
  );
});

it("restarts into the prepared release after the requested delay", async () => {
  prepareUpdate.mockResolvedValueOnce({
    status: "pending",
    target: { version: "2.0.0" },
    releaseRoot: "/tmp/release",
  } as never);
  const { payload } = await invoke({ restartDelayMs: 7000 });
  expect(payload).toMatchObject({ ok: true });
  await vi.waitFor(() =>
    expect(scheduleGatewayRestart).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "update.run", delayMs: 7000 }),
    ),
  );
});

it("refuses a different checkout before recording any run and names the installed command", async () => {
  install.root = path.join(home.home, "installation-a");
  await fs.mkdir(install.root);
  await runCommandWithTimeout(["git", "init", install.root], { timeoutMs: 10_000 });
  const { payload } = await invoke({
    checkout: { gitCommonDir: path.join(home.home, "installation-b", ".git") },
    acceptCapabilities: true,
  });
  expect(payload).toMatchObject({ runId: null, ok: false, code: "installation-mismatch" });
  expect(payload.message).toContain(install.root);
  expect(payload.message).toContain("Nothing changed.");
  expect(payload.message).toContain(`${install.root}/openclaw.mjs update`);
  expect(await listUpdateRunsAsync()).toEqual([]);
  expect(prepareUpdate).not.toHaveBeenCalled();
});

it("accepts the same Git common directory and passes capability consent to preparation", async () => {
  install.root = path.join(home.home, "installation-a");
  await fs.mkdir(install.root);
  await runCommandWithTimeout(["git", "init", install.root], { timeoutMs: 10_000 });
  await runCommandWithTimeout(
    [
      "git",
      "-C",
      install.root,
      "-c",
      "user.name=Identity Fixture",
      "-c",
      "user.email=identity@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    { timeoutMs: 10_000 },
  );
  const commonDir = await fs.realpath(path.join(install.root, ".git"));
  const release = path.join(home.home, "release-worktree");
  await runCommandWithTimeout(["git", "-C", install.root, "worktree", "add", "--detach", release], {
    timeoutMs: 10_000,
  });
  install.root = release;
  const { payload } = await invoke({
    checkout: { gitCommonDir: commonDir },
    acceptCapabilities: true,
  });
  expect(payload).toMatchObject({ ok: true });
  await vi.waitFor(() =>
    expect(prepareUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ acceptCapabilities: true }),
    ),
  );
});
