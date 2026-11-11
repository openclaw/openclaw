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
afterEach(() => closeOpenClawStateDatabaseAsync());

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
  const record = makeWorktreeRecord(repoRoot, "worktree-id", { ownerKind: "manual" });
  using create = vi.spyOn(managedWorktrees, "create").mockResolvedValue(record);
  const respond = vi.fn();
  await handleGatewayRequest({
    req: gatewayRequest("req-worktree-create", "worktrees.create", { repoRoot }),
    respond,
    client: {
      connId: "conn-worktree-create",
      connect: gatewayConnect([admin ? "operator.admin" : "operator.write"]),
    } as Parameters<typeof handleGatewayRequest>[0]["client"],
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => ({ agents: { entries: { main: { workspace } } } }),
      logGateway: { warn: vi.fn() },
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
    extraHandlers: worktreesHandlers,
  });
  if (allowed) {
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot, runSetupScript: admin }),
    );
    expect(respond).toHaveBeenCalledWith(true, record, undefined);
  } else {
    expect(create).not.toHaveBeenCalled();
    const error = expect.objectContaining({
      code: "FORBIDDEN",
      message: "missing scope: operator.admin",
      details: {
        code: "MISSING_SCOPE",
        missingScope: "operator.admin",
        requiredScopes: ["operator.admin"],
      },
    });
    expect(respond).toHaveBeenCalledWith(false, undefined, error);
  }
});
