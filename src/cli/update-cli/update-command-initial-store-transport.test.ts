import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  type UpdateInitialStoreInvocation,
  withUpdateInitialStoreInvocation,
} from "../../infra/update-initial-store-invocation.js";
import * as leaseOwner from "../../infra/update-managed-service-handoff-lease.js";
import { finishUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { captureUpdateCommandExecutorAuthority } from "./update-command-executor.js";
import { withInitialStoreFixture } from "./update-command-initial-store.test-support.js";
import * as runOwner from "./update-command-run.js";
import * as targetOwner from "./update-command-target.js";
import { updateCommand } from "./update-command.js";

async function withOrdinaryFixture(operation: Parameters<typeof withInitialStoreFixture>[0]) {
  await withInitialStoreFixture(
    async (fixture) => {
      // Only target discovery is controlled; run admission, SQLite, executor and settlement are real.
      vi.spyOn(runOwner, "prepareUpdateCommand").mockResolvedValue(fixture.prepared);
      await operation(fixture);
    },
    { applicationState: true },
  );
}

function commandInputs(
  input: UpdateInitialStoreInvocation,
  route: "input" | "executor" | "both" | "ambient",
): Parameters<typeof updateCommand> {
  return [
    { json: true, ...(route === "input" || route === "both" ? { initialStores: input } : {}) },
    route === "executor" || route === "both"
      ? {
          directOriginal: { databasePath: input.selection.handoff.databasePath },
          initialStores: { protocol: "initial-pair-v1", selection: input.selection },
        }
      : undefined,
  ];
}

it.each(["input", "executor", "both", "ambient"] as const)(
  "admits the real ordinary run with selection=%s and settles its selected row",
  async (route) => {
    const selected = route !== "ambient";
    await withOrdinaryFixture(async ({ root, installation, env, input, store }) => {
      const ambient = vi.mocked(leaseOwner.resolveManagedUpdateLeaseDatabasePath);
      ambient.mockClear();
      if (selected) {
        ambient.mockImplementation(() => {
          throw new Error("ambient admission forbidden");
        });
      }
      let admittedRunId: string | undefined;
      vi.spyOn(targetOwner, "resolveUpdateCommandTarget").mockImplementation(
        async (opts, _recovery, _cwd, _prepared, executor) => {
          await Promise.resolve();
          expect(opts.run).toBeDefined();
          const run = opts.run;
          if (!run) {
            throw new Error("Ordinary entry did not admit a real run");
          }
          admittedRunId = run.runId;
          expect(getUpdateRun(run.runId, { env: run.env })?.runId).toBe(run.runId);
          const fence = await executor.enter(installation, { preflight: true });
          const authority = captureUpdateCommandExecutorAuthority(fence, run.runId);
          expect(authority.databasePath).toBe(input.selection.handoff.databasePath);
          expect(store.read(installation)).toMatchObject({
            kind: "current",
            lease: { owner: authority.owner },
          });
          fence.assertCurrent();
          fs.writeFileSync(path.join(root, "ordinary-effect"), run.runId);
          finishUpdateRun(
            run.runId,
            { status: "skipped", reason: "controlled-target-stop" },
            { env: run.env },
          );
          return undefined;
        },
      );
      await updateCommand(...commandInputs(input, route));
      expect(admittedRunId).toBeTruthy();
      expect(fs.readFileSync(path.join(root, "ordinary-effect"), "utf8")).toBe(admittedRunId);
      if (!admittedRunId) {
        throw new Error("Ordinary entry did not reach the controlled target");
      }
      expect(getUpdateRun(admittedRunId, { env })?.status).toBe("skipped");
      expect(store.read(installation)).toEqual({ kind: "absent" });
      if (selected) {
        expect(ambient).not.toHaveBeenCalled();
      } else {
        expect(ambient).toHaveBeenCalled();
      }
    });
  },
);

it.each(["input", "executor"] as const)(
  "refuses invalid initial physical identity before ordinary preparation or run admission (%s)",
  async (route) => {
    await withOrdinaryFixture(async ({ input }) => {
      const prepare = vi.mocked(runOwner.prepareUpdateCommand);
      const admit = vi.spyOn(runOwner, "admitUpdateCommandRun");
      vi.spyOn(targetOwner, "resolveUpdateCommandTarget").mockResolvedValue(undefined);
      const invalid = {
        ...input,
        selection: {
          ...input.selection,
          state: { ...input.selection.state, databaseIdentity: "0:0" },
        },
      };
      await expect(updateCommand(...commandInputs(invalid, route))).rejects.toThrow();
      expect(prepare).not.toHaveBeenCalled();
      expect(admit).not.toHaveBeenCalled();
    });
  },
);

it.each(["input", "executor"] as const)(
  "rechecks the installation returned by asynchronous preparation before any run admission (%s)",
  async (route) => {
    await withOrdinaryFixture(async ({ root, input, prepared }) => {
      const other = path.join(root, "other-installation");
      fs.mkdirSync(other, { mode: 0o700 });
      vi.mocked(runOwner.prepareUpdateCommand).mockImplementation(async () => {
        await Promise.resolve();
        return { ...prepared, discoveredRoot: other };
      });
      const admit = vi.spyOn(runOwner, "admitUpdateCommandRun");
      const target = vi
        .spyOn(targetOwner, "resolveUpdateCommandTarget")
        .mockResolvedValue(undefined);
      await expect(updateCommand(...commandInputs(input, route))).rejects.toThrow(
        "effective installation or store selectors diverged",
      );
      expect(admit).not.toHaveBeenCalled();
      expect(target).not.toHaveBeenCalled();
    });
  },
);

it.each(["input", "executor"] as const)(
  "refuses a state generation replaced during preparation before history or target work (%s)",
  async (route) => {
    await withOrdinaryFixture(async ({ input, prepared }) => {
      const statePath = input.selection.state.databasePath;
      const before = fs.readFileSync(statePath);
      vi.mocked(runOwner.prepareUpdateCommand).mockImplementation(async () => {
        await Promise.resolve();
        fs.renameSync(statePath, statePath + ".retained");
        fs.writeFileSync(statePath, before, { mode: 0o600 });
        return prepared;
      });
      const admit = vi.spyOn(runOwner, "admitUpdateCommandRun");
      const target = vi
        .spyOn(targetOwner, "resolveUpdateCommandTarget")
        .mockResolvedValue(undefined);
      await expect(updateCommand(...commandInputs(input, route))).rejects.toThrow(
        "database generation changed",
      );
      expect(admit).not.toHaveBeenCalled();
      expect(target).not.toHaveBeenCalled();
      expect(fs.readFileSync(statePath)).toEqual(before);
      expect(fs.readFileSync(statePath + ".retained")).toEqual(before);
    });
  },
);

it("rejects conflicting initial selections before preparation or ledger effects", async () => {
  await withOrdinaryFixture(async ({ root, input }) => {
    const other = path.join(root, "other-installation");
    fs.mkdirSync(other, { mode: 0o700 });
    const stat = fs.lstatSync(other, { bigint: true });
    const alternate = {
      ...input,
      selection: {
        ...input.selection,
        installation: { path: other, identity: String(stat.dev) + ":" + String(stat.ino) },
      },
    };
    const before = fs.readFileSync(input.selection.state.databasePath);
    const admit = vi.spyOn(runOwner, "admitUpdateCommandRun");
    const target = vi.spyOn(targetOwner, "resolveUpdateCommandTarget").mockResolvedValue(undefined);
    await expect(
      updateCommand({ json: true, initialStores: input }, commandInputs(alternate, "executor")[1]),
    ).rejects.toThrow("Conflicting update initial store selections");
    expect(runOwner.prepareUpdateCommand).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
    expect(target).not.toHaveBeenCalled();
    expect(fs.readFileSync(input.selection.state.databasePath)).toEqual(before);
  });
});

it("does not revive a settled lexical invocation through ordinary entry", async () => {
  await withOrdinaryFixture(async ({ input }) => {
    vi.spyOn(targetOwner, "resolveUpdateCommandTarget").mockResolvedValue(undefined);
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let pending: Promise<void> | undefined;
    await withUpdateInitialStoreInvocation(input, async () => {
      pending = (async () => {
        await gate;
        await updateCommand({ json: true });
      })();
    });
    resume();
    await expect(pending).rejects.toThrow("Update initial store invocation has settled");
    expect(runOwner.prepareUpdateCommand).not.toHaveBeenCalled();
  });
});

it.each(["input", "executor"] as const)(
  "refuses selector drift during real run readmission before creating another state store (%s)",
  async (route) => {
    await withOrdinaryFixture(async ({ root, input, prepared }) => {
      const other = path.join(root, "other-state");
      fs.mkdirSync(other, { mode: 0o700 });
      let inspections = 0;
      prepared.pkgOwnership.assertUnowned = async () => {
        await Promise.resolve();
        if (++inspections === 2) {
          process.env.OPENCLAW_STATE_DIR = other;
        }
      };
      const target = vi
        .spyOn(targetOwner, "resolveUpdateCommandTarget")
        .mockResolvedValue(undefined);
      await expect(updateCommand(...commandInputs(input, route))).rejects.toThrow(
        "effective installation or store selectors diverged",
      );
      expect(inspections).toBe(2);
      expect(target).not.toHaveBeenCalled();
      expect(fs.readdirSync(other)).toEqual([]);
    });
  },
);

it.each(["ordinary", "initialization"] as const)(
  "refuses unbound managed %s ingress without acquiring a direct owner",
  async (route) => {
    await withOrdinaryFixture(async ({ root, installation, input }) => {
      const issuer = vi.fn(async () => {
        throw new Error("unbound issuer must not run");
      });
      const effect = path.join(root, "forbidden-managed-effect");
      let refusal: unknown;
      const target = vi
        .spyOn(targetOwner, "resolveUpdateCommandTarget")
        .mockImplementation(async (_opts, _recovery, _cwd, _prepared, executor) => {
          try {
            (
              await executor.enter(installation, { preflight: true, serviceRoot: undefined })
            ).assertCurrent();
          } catch (error) {
            refusal = error;
            throw error;
          }
          fs.writeFileSync(effect, "unbound direct fallback");
          return undefined;
        });
      const managedOptions = {
        initialStores: { protocol: "initial-pair-v1" as const, selection: input.selection },
        managedGeneration: issuer,
      };
      if (route === "initialization") {
        // Select the initialization branch only; retain its real executor and admission.
        const initialization = await import("./update-command-initialization.js");
        vi.spyOn(initialization, "updateStateNeedsInitialization").mockResolvedValue(true);
      }
      await expect(updateCommand({ json: true }, managedOptions)).rejects.toThrow(
        route === "ordinary"
          ? "exit 1"
          : "Explicit private update invocation requires existing initialized state",
      );
      if (route === "ordinary") {
        expect(refusal).toMatchObject({
          message: "Managed planned installation is not the bound root.",
        });
        expect(target).toHaveBeenCalledOnce();
      } else {
        expect(refusal).toBeUndefined();
        expect(target).not.toHaveBeenCalled();
      }
      expect(issuer).not.toHaveBeenCalled();
      expect(fs.existsSync(effect)).toBe(false);
    });
  },
);
