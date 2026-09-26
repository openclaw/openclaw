import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withUpdateInitialStoreInvocation } from "../../infra/update-initial-store-invocation.js";
import * as leaseOwner from "../../infra/update-managed-service-handoff-lease.js";
import { captureUpdateCommandExecutorAuthority } from "./update-command-executor.js";
import { withInitialStoreFixture as withFixture } from "./update-command-initial-store.test-support.js";
import * as targetOwner from "./update-command-target.js";

it("uses the admitted pair for a fresh real owner, preserves state and settles the row without ambient resolution", async () => {
  await withFixture(async ({ root, installation, input, store, initialize }) => {
    const before = fs.readFileSync(input.selection.state.databasePath);
    const ambient = vi.mocked(leaseOwner.resolveManagedUpdateLeaseDatabasePath);
    ambient.mockClear().mockImplementation(() => {
      throw new Error("ambient admission forbidden");
    });
    let owner: string | undefined;
    const target = vi
      .spyOn(targetOwner, "resolveUpdateCommandTarget")
      .mockImplementation(async (_opts, _recovery, _cwd, _prepared, executor) => {
        await Promise.resolve();
        const fence = await executor.enter(installation, { preflight: true });
        const authority = captureUpdateCommandExecutorAuthority(fence, "initialization-transport");
        expect(authority.databasePath).toBe(input.selection.handoff.databasePath);
        owner = authority.owner;
        expect(store.read(installation)).toMatchObject({ kind: "current", lease: { owner } });
        fence.assertCurrent();
        fs.writeFileSync(path.join(root, "admitted-effect"), "selected original");
        return undefined;
      });
    await withUpdateInitialStoreInvocation(input, initialize);
    expect(target).toHaveBeenCalledOnce();
    expect(owner).toBeTruthy();
    expect(fs.readFileSync(path.join(root, "admitted-effect"), "utf8")).toBe("selected original");
    expect(fs.readFileSync(input.selection.state.databasePath)).toEqual(before);
    expect(ambient).not.toHaveBeenCalled();
  });
});

it("keeps ordinary initialization on its explicitly isolated existing resolver", async () => {
  await withFixture(async ({ installation, initialize }) => {
    const target = vi
      .spyOn(targetOwner, "resolveUpdateCommandTarget")
      .mockImplementation(async (_opts, _recovery, _cwd, _prepared, executor) => {
        (await executor.enter(installation, { preflight: true })).assertCurrent();
        return undefined;
      });
    await initialize();
    expect(target).toHaveBeenCalledOnce();
    expect(leaseOwner.resolveManagedUpdateLeaseDatabasePath).toHaveBeenCalled();
  });
});

it("refuses a divergent state selector before target resolution or native store admission", async () => {
  await withFixture(async ({ root, env, input, initialize }) => {
    const other = path.join(root, "other-state");
    const target = vi.spyOn(targetOwner, "resolveUpdateCommandTarget").mockResolvedValue(undefined);
    const open = vi.mocked(leaseOwner.createManagedHandoffLeaseStore);
    open.mockClear();
    await expect(
      withUpdateInitialStoreInvocation(input, () =>
        initialize({ ...env, OPENCLAW_STATE_DIR: other }),
      ),
    ).rejects.toThrow("effective installation or store selectors diverged");
    expect(target).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(fs.existsSync(other)).toBe(false);
  });
});

it("revalidates the selected state inode after target lookup yields, before acquiring a native row", async () => {
  await withFixture(async ({ installation, input, store, initialize }) => {
    const statePath = input.selection.state.databasePath;
    const before = fs.readFileSync(statePath);
    const ambient = vi.mocked(leaseOwner.resolveManagedUpdateLeaseDatabasePath);
    ambient.mockClear().mockImplementation(() => {
      throw new Error("ambient admission forbidden");
    });
    const effect = vi.fn();
    vi.spyOn(targetOwner, "resolveUpdateCommandTarget").mockImplementation(
      async (_opts, _recovery, _cwd, _prepared, executor) => {
        await Promise.resolve();
        fs.renameSync(statePath, statePath + ".retained");
        fs.writeFileSync(statePath, before, { mode: 0o600 });
        await executor.enter(installation, { preflight: true });
        effect();
        return undefined;
      },
    );
    await expect(withUpdateInitialStoreInvocation(input, initialize)).rejects.toThrow(
      "database generation changed",
    );
    expect(effect).not.toHaveBeenCalled();
    expect(ambient).not.toHaveBeenCalled();
    expect(store.read(installation)).toEqual({ kind: "absent" });
    expect(fs.readFileSync(statePath)).toEqual(before);
    expect(fs.readFileSync(statePath + ".retained")).toEqual(before);
  });
});

it("does not revive an invocation after its lexical lifetime settles", async () => {
  await withFixture(async ({ input, initialize }) => {
    const target = vi.spyOn(targetOwner, "resolveUpdateCommandTarget").mockResolvedValue(undefined);
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let pending: Promise<void> | undefined;
    await withUpdateInitialStoreInvocation(input, async () => {
      pending = (async () => {
        await gate;
        await initialize();
      })();
    });
    resume();
    await expect(pending).rejects.toThrow("Update initial store invocation has settled");
    expect(target).not.toHaveBeenCalled();
  });
});
