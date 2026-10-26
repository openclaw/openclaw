import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { makeWorktreeRecord } from "../../agents/worktrees/service.test-support.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { gatewayRequest } from "../request-frame.test-support.js";
import { handleGatewayRequest } from "../server-methods.js";
import { gatewayConnect } from "../server/client-fixtures.test-support.js";
import { worktreesHandlers } from "./worktrees.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
});

const worktreeRecord = (repoRoot: string) =>
  makeWorktreeRecord(repoRoot, "worktree-id", { ownerKind: "manual" });

async function dispatchCreate(params: { repoRoot: string; scopes: string[]; workspace: string }) {
  const create = vi.fn(async () => worktreeRecord(params.repoRoot));
  using _ = vi.spyOn(managedWorktrees, "create").mockImplementation(create);
  const respond = vi.fn();
  await handleGatewayRequest({
    req: gatewayRequest("req-worktree-create", "worktrees.create", { repoRoot: params.repoRoot }),
    respond,
    client: {
      connId: "conn-worktree-create",
      connect: gatewayConnect(params.scopes, { id: "test", version: "1", mode: "test" }),
    } as Parameters<typeof handleGatewayRequest>[0]["client"],
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => ({
        agents: { entries: { main: { workspace: params.workspace } } },
      }),
      logGateway: { warn: vi.fn() },
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
    extraHandlers: worktreesHandlers,
  });
  return { create, respond };
}

it.each([
  { inside: true, admin: false, allowed: true },
  { inside: false, admin: false, allowed: false },
  { inside: false, admin: true, allowed: true },
])("worktrees.create authorization: %j", async ({ inside, admin, allowed }) => {
  const root = await fs.realpath(tempDirs.make("openclaw-worktree-create-auth-"));
  const workspace = path.join(root, "workspace");
  const repoRoot = inside ? path.join(workspace, "project") : path.join(root, "outside");
  await fs.mkdir(repoRoot, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  const { create, respond } = await dispatchCreate({
    repoRoot,
    scopes: [admin ? "operator.admin" : "operator.write"],
    workspace,
  });
  if (allowed) {
    expect(create).toHaveBeenCalledWith({
      repoRoot,
      name: undefined,
      baseRef: undefined,
      ownerKind: "manual",
      runSetupScript: admin,
    });
    expect(respond).toHaveBeenCalledWith(true, worktreeRecord(repoRoot), undefined);
  } else {
    expect(create).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "FORBIDDEN",
        message: "missing scope: operator.admin",
        details: {
          code: "MISSING_SCOPE",
          missingScope: "operator.admin",
          requiredScopes: ["operator.admin"],
        },
      }),
    );
  }
});
